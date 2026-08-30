import { Injectable, BadRequestException, HttpException, HttpStatus, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  rpc,
  TransactionBuilder,
  Transaction,
  Keypair,
  nativeToScVal,
  scValToNative,
  Address,
  Contract,
  Account,
  BASE_FEE,
  xdr,
} from '@stellar/stellar-sdk';
import { StellarService } from './stellar.service';
import { NonceService } from '../common/services/nonce.service';

const POLL_INITIAL_INTERVAL_MS = 1_000;
const POLL_MAX_INTERVAL_MS = 5_000;
const TX_CONFIRM_TIMEOUT_MS = Number(process.env.TX_CONFIRM_TIMEOUT_MS) || 30_000;

export interface ContractCallOptions {
  contractAddress: string;
  method: string;
  args: xdr.ScVal[];
  sourceSecretKey?: string;
}

export interface ContractCallResult {
  result: xdr.ScVal;
  transactionHash?: string;
  successful: boolean;
}

export interface PreparedTransaction {
  xdr: string;
  nonce: number;
}

@Injectable()
export class ContractService implements OnModuleDestroy {
  private sorobanRpc: rpc.Server;
  private readonly logger = new Logger(ContractService.name);

  /**
   * When true, sendTransaction() will reject new submissions immediately.
   * Set by onModuleDestroy() before waiting for in-flight transactions.
   */
  private shuttingDown = false;

  /**
   * Every active pollTransactionConfirmation() call is tracked here.
   * onModuleDestroy() waits for all of them to settle before returning,
   * giving in-flight blockchain transactions a chance to reach a terminal
   * state (SUCCESS or FAILED) before the process exits.
   */
  private readonly inFlightTransactions = new Set<Promise<xdr.ScVal>>();

  constructor(
    private readonly stellarService: StellarService,
    private readonly nonceService: NonceService,
  ) {
    this.sorobanRpc = new rpc.Server(
      process.env.SOROBAN_RPC_URL || 'http://localhost:8000/soroban/rpc',
      { allowHttp: true },
    );
  }

  async simulateCall(options: ContractCallOptions): Promise<xdr.ScVal> {
    try {
      const { contractAddress, method, args } = options;

      const keypair = options.sourceSecretKey
        ? Keypair.fromSecret(options.sourceSecretKey)
        : Keypair.random();

      const account = new Account(keypair.publicKey(), '0');
      const contract = new Contract(contractAddress);

      const transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.stellarService.getNetworkPassphrase(),
      })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();

      const simulation = await this.sorobanRpc.simulateTransaction(transaction);

      if (rpc.Api.isSimulationError(simulation)) {
        throw new BadRequestException(
          `Contract simulation failed: ${this.describeSimulationError(simulation.error, simulation.events)}`,
        );
      }

      if (!simulation.result) {
        throw new BadRequestException(
          'Simulation returned no result',
        );
      }

      return simulation.result.retval;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        `Failed to simulate contract call: ${error.message}`,
      );
    }
  }

  async sendTransaction(options: ContractCallOptions): Promise<ContractCallResult> {
    try {
      const { contractAddress, method, args, sourceSecretKey } = options;

      if (!sourceSecretKey) {
        throw new BadRequestException(
          'sourceSecretKey is required for state-changing transactions',
        );
      }

      // Reject new submissions once shutdown has been requested so we do not
      // start transactions we cannot wait for.
      if (this.shuttingDown) {
        throw new HttpException(
          'Service is shutting down — transaction submission refused',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      const keypair = Keypair.fromSecret(sourceSecretKey);
      const contract = new Contract(contractAddress);

      const horizonAccount = await this.stellarService.getAccount(keypair.publicKey());
      const account = new Account(keypair.publicKey(), horizonAccount.sequence);

      const transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.stellarService.getNetworkPassphrase(),
      })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();

      const simulation = await this.sorobanRpc.simulateTransaction(transaction);

      if (rpc.Api.isSimulationError(simulation)) {
        throw new BadRequestException(
          `Transaction simulation failed: ${this.describeSimulationError(simulation.error, simulation.events)}`,
        );
      }

      const preparedTransaction = await this.sorobanRpc.prepareTransaction(transaction);

      preparedTransaction.sign(keypair);

      const response = await this.sorobanRpc.sendTransaction(preparedTransaction);

      if (response.status === 'ERROR') {
        const errorMessage = this.decodeContractError(contractAddress, method);
        throw new BadRequestException(errorMessage);
      }

      const hash = response.hash;

      // Track the confirmation promise so onModuleDestroy() can wait for it.
      const confirmationPromise = this.pollTransactionConfirmation(hash, contractAddress, keypair.publicKey(), method);
      this.inFlightTransactions.add(confirmationPromise);
      confirmationPromise
        .catch(() => {}) // prevent unhandled-rejection detection; error re-thrown via await below
        .finally(() => this.inFlightTransactions.delete(confirmationPromise));

      // Poll getTransaction until the transaction is included in a ledger
      // or the timeout expires.  Without this confirmation step the nonce
      // mirror in Redis can diverge from on-chain state: sendTransaction
      // returns while the tx is still PENDING, the caller increments the
      // nonce, and the next submission fails with InvalidNonce.
      const retval = await confirmationPromise;

      return {
        result: retval,
        transactionHash: hash,
        successful: true,
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof HttpException) {
        throw error;
      }
      throw new BadRequestException(
        `Failed to submit contract transaction: ${error.message}`,
      );
    }
  }

  /**
   * Builds an UNSIGNED Soroban contract-invocation transaction and returns it
   * as base64 XDR, without signing or submitting it.
   *
   * This is the first half of the pre-signed-transaction flow that replaced
   * server-side custody of investor keys: the caller (typically a request
   * handler acting on behalf of an authenticated wallet owner) reserves a
   * nonce via NonceService.next() *before* calling this method, passes it in
   * as `nonce`, and the resulting XDR is handed back to that wallet owner to
   * sign externally (e.g. with Freighter) and POST back to
   * submitSignedTransaction(). The nonce is appended as the final contract
   * call argument, mirroring invokeContractMethod()/sendTransaction().
   *
   * `sourceAddress` is a public key (G...), not a secret — nothing here ever
   * touches a private key, since the transaction is never signed server-side.
   */
  async prepareTransaction(
    contractAddress: string,
    method: string,
    sourceAddress: string,
    args: unknown[],
    nonce: number,
  ): Promise<PreparedTransaction> {
    try {
      if (this.shuttingDown) {
        throw new HttpException(
          'Service is shutting down — transaction preparation refused',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      const encodedArgs = args.map((arg) =>
        arg instanceof xdr.ScVal ? arg : nativeToScVal(arg),
      );
      const nonceScVal = nativeToScVal(BigInt(nonce), { type: 'u64' });
      const allArgs = [...encodedArgs, nonceScVal];

      const contract = new Contract(contractAddress);
      const horizonAccount = await this.stellarService.getAccount(sourceAddress);
      const account = new Account(sourceAddress, horizonAccount.sequence);

      const transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.stellarService.getNetworkPassphrase(),
      })
        .addOperation(contract.call(method, ...allArgs))
        .setTimeout(30)
        .build();

      const simulation = await this.sorobanRpc.simulateTransaction(transaction);

      if (rpc.Api.isSimulationError(simulation)) {
        throw new BadRequestException(
          `Transaction simulation failed: ${this.describeSimulationError(simulation.error, simulation.events)}`,
        );
      }

      const preparedTransaction = await this.sorobanRpc.prepareTransaction(transaction);

      return { xdr: preparedTransaction.toXDR(), nonce };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof HttpException) {
        throw error;
      }
      throw new BadRequestException(
        `Failed to prepare contract transaction: ${error.message}`,
      );
    }
  }

  /**
   * Submits an already-signed transaction envelope (base64 XDR) produced by
   * prepareTransaction() and signed externally by the wallet owner.
   *
   * The envelope is untrusted client input, so before submitting it this
   * validates (defense in depth):
   *   - it decodes to a plain Transaction, not a FeeBumpTransaction
   *   - its source account matches `expectedSourceAddress`
   *   - it contains exactly one operation
   *   - that operation is an invokeHostFunction call
   *   - the invoked contract address and function name match `contractAddress`
   *     and `method`, so a signed envelope prepared for a different call
   *     cannot be replayed against this contract/method pair
   *
   * Any mismatch throws BadRequestException rather than silently submitting
   * an envelope that does not match what the caller expected. On a valid
   * match the transaction is submitted as-is (it is already signed) and the
   * same submit+poll+nonce-rollback path used by sendTransaction() is reused.
   */
  async submitSignedTransaction(
    signedXdr: string,
    contractAddress: string,
    method: string,
    expectedSourceAddress: string,
  ): Promise<ContractCallResult> {
    if (this.shuttingDown) {
      throw new HttpException(
        'Service is shutting down — transaction submission refused',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const transaction = this.decodeSignedTransaction(
      signedXdr,
      contractAddress,
      method,
      expectedSourceAddress,
    );

    try {
      const response = await this.sorobanRpc.sendTransaction(transaction);

      if (response.status === 'ERROR') {
        const errorMessage = this.decodeContractError(contractAddress, method);
        throw new BadRequestException(errorMessage);
      }

      const hash = response.hash;

      const confirmationPromise = this.pollTransactionConfirmation(
        hash, contractAddress, expectedSourceAddress, method,
      );
      this.inFlightTransactions.add(confirmationPromise);
      confirmationPromise.then(
        () => this.inFlightTransactions.delete(confirmationPromise),
        () => this.inFlightTransactions.delete(confirmationPromise),
      );

      const retval = await confirmationPromise;

      return {
        result: retval,
        transactionHash: hash,
        successful: true,
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof HttpException) {
        throw error;
      }
      throw new BadRequestException(
        `Failed to submit signed contract transaction: ${error.message}`,
      );
    }
  }

  /**
   * Parses and validates a signed envelope for submitSignedTransaction().
   * Split out from submitSignedTransaction() so validation failures are
   * always synchronous BadRequestExceptions, never wrapped by the generic
   * submission try/catch.
   */
  private decodeSignedTransaction(
    signedXdr: string,
    contractAddress: string,
    method: string,
    expectedSourceAddress: string,
  ): Transaction {
    let parsed: ReturnType<typeof TransactionBuilder.fromXDR>;
    try {
      parsed = TransactionBuilder.fromXDR(signedXdr, this.stellarService.getNetworkPassphrase());
    } catch (error) {
      throw new BadRequestException(
        `Malformed signed transaction XDR: ${error instanceof Error ? error.message : error}`,
      );
    }

    if (!(parsed instanceof Transaction)) {
      throw new BadRequestException(
        'Fee-bump transactions are not supported for this operation',
      );
    }

    if (parsed.source !== expectedSourceAddress) {
      throw new BadRequestException(
        'Signed transaction source account does not match the expected signer address',
      );
    }

    if (parsed.operations.length !== 1) {
      throw new BadRequestException(
        'Signed transaction must contain exactly one operation',
      );
    }

    const operation = parsed.operations[0];
    if (operation.type !== 'invokeHostFunction') {
      throw new BadRequestException(
        'Signed transaction must be a contract invocation',
      );
    }

    const hostFunction = operation.func;
    if (hostFunction.switch().name !== 'hostFunctionTypeInvokeContract') {
      throw new BadRequestException(
        'Signed transaction must invoke a contract function',
      );
    }

    const invokeArgs = hostFunction.invokeContract();
    const calledContract = Address.fromScAddress(invokeArgs.contractAddress()).toString();
    const calledMethod = invokeArgs.functionName().toString();

    if (calledContract !== contractAddress) {
      throw new BadRequestException(
        'Signed transaction targets an unexpected contract address',
      );
    }
    if (calledMethod !== method) {
      throw new BadRequestException(
        'Signed transaction targets an unexpected contract method',
      );
    }

    return parsed;
  }

  /**
   * Polls getTransaction with exponential backoff until the transaction
   * is confirmed (SUCCESS or FAILED) or the timeout expires.
   *
   * On SUCCESS: extracts the return value from the transaction metadata.
   * On FAILED: rolls back the Redis nonce and throws.
   * On timeout: rolls back the Redis nonce and throws a 504 GatewayTimeout.
   */
  private async pollTransactionConfirmation(
    hash: string,
    contractAddress: string,
    address: string,
    method: string,
  ): Promise<xdr.ScVal> {
    const deadline = Date.now() + TX_CONFIRM_TIMEOUT_MS;
    let interval = POLL_INITIAL_INTERVAL_MS;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, interval));

      let txStatus: rpc.Api.GetTransactionResponse;
      try {
        txStatus = await this.sorobanRpc.getTransaction(hash);
      } catch (rpcError) {
        this.logger.warn(
          `pollTransactionConfirmation: getTransaction(${hash}) failed: ${rpcError?.message ?? rpcError}`,
        );
        interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS);
        continue;
      }

      if (txStatus.status === 'SUCCESS') {
        return this.extractReturnValue(txStatus, contractAddress, method);
      }

      if (txStatus.status === 'FAILED') {
        await this.nonceService.rollback(contractAddress, address).catch((err) => {
          this.logger.warn(
            `pollTransactionConfirmation: nonce rollback failed after FAILED tx for ${address}: ${err?.message ?? err}`,
          );
        });
        throw new BadRequestException(
          `Contract error on ${contractAddress}.${method} (transaction ${hash} failed on-chain)`,
        );
      }

      // NOT_FOUND — not yet included in a ledger; back off and retry.
      interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS);
    }

    // Timed out — roll back the nonce so the caller can retry.
    await this.nonceService.rollback(contractAddress, address).catch((err) => {
      this.logger.warn(
        `pollTransactionConfirmation: nonce rollback failed after timeout for ${address}: ${err?.message ?? err}`,
      );
    });
    throw new HttpException(
      `Transaction confirmation timed out after ${TX_CONFIRM_TIMEOUT_MS}ms (tx ${hash})`,
      HttpStatus.GATEWAY_TIMEOUT,
    );
  }

  /**
   * Extracts the Soroban return value from a confirmed transaction's
   * result metadata.  Returns scvVoid() when the meta does not contain a
   * Soroban return value (e.g. a method that genuinely returns void, or a
   * non-Soroban transaction).  If the metadata decoding itself fails
   * (e.g. an SDK/ABI mismatch after a contract upgrade) a WARN is logged
   * with the contract address and method so the failure is diagnosable
   * rather than silently producing an empty response.
   */
  private extractReturnValue(
    txResponse: rpc.Api.GetTransactionResponse,
    contractAddress: string,
    method: string,
  ): xdr.ScVal {
    if (txResponse.status !== 'SUCCESS') {
      // Non-success / non-Soroban transaction: void is the expected result.
      return xdr.ScVal.scvVoid();
    }
    try {
      const meta = (txResponse as rpc.Api.GetSuccessfulTransactionResponse).resultMetaXdr;
      const v3 = meta.v3();
      const sorobanMeta = v3?.sorobanMeta();
      const retval = sorobanMeta?.returnValue();
      if (retval) {
        return retval;
      }
      // No return value present in meta: the contract method returned void.
      return xdr.ScVal.scvVoid();
    } catch (error) {
      this.logger.warn(
        `extractReturnValue: failed to decode return value for ${contractAddress}.${method} ` +
          `(possible SDK/ABI mismatch), falling back to scvVoid: ` +
          `${error instanceof Error ? error.message : error}`,
        { contractAddress, method, error },
      );
      return xdr.ScVal.scvVoid();
    }
  }

  encodeArg(value: unknown, type: string): xdr.ScVal {
    switch (type) {
      case 'address': {
        return Address.fromString(value as string).toScVal();
      }
      case 'i128': {
        return nativeToScVal(BigInt(value as number | bigint | string), { type: 'i128' });
      }
      case 'u64': {
        return nativeToScVal(BigInt(value as number | bigint | string), { type: 'u64' });
      }
      case 'bytes': {
        const buf = Buffer.from(value as string, 'hex');
        return xdr.ScVal.scvBytes(buf);
      }
      case 'symbol': {
        return nativeToScVal(value as string, { type: 'symbol' });
      }
      case 'string': {
        return nativeToScVal(value as string, { type: 'string' });
      }
      case 'bool': {
        return xdr.ScVal.scvBool(value as boolean);
      }
      case 'u32': {
        return xdr.ScVal.scvU32(value as number);
      }
      case 'i32': {
        return xdr.ScVal.scvI32(value as number);
      }
      case 'void': {
        return xdr.ScVal.scvVoid();
      }
      case 'vec': {
        return xdr.ScVal.scvVec(value as xdr.ScVal[]);
      }
      case 'map': {
        return xdr.ScVal.scvMap(value as xdr.ScMapEntry[]);
      }
      default:
        throw new BadRequestException(`Unsupported ScVal type: ${type}`);
    }
  }

  decodeArg(scval: xdr.ScVal): unknown {
    return scValToNative(scval);
  }

  async invokeContractMethod(
    contractAddress: string,
    method: string,
    callerSecretKey: string,
    args: unknown[],
    nonce: number,
  ): Promise<ContractCallResult> {
    const encodedArgs = args.map((arg) => {
      if (arg instanceof xdr.ScVal) {
        return arg;
      }
      return nativeToScVal(arg);
    });

    const nonceScVal = nativeToScVal(BigInt(nonce), { type: 'u64' });
    const allArgs = [...encodedArgs, nonceScVal];

    return this.sendTransaction({
      contractAddress,
      method,
      args: allArgs,
      sourceSecretKey: callerSecretKey,
    });
  }

  private describeSimulationError(
    error?: string,
    events?: xdr.DiagnosticEvent[],
  ): string {
    const code = this.extractContractErrorCode(error, events);
    if (code !== undefined) {
      return `${error || 'host error'} (contract error code ${code})`;
    }
    return error || 'unknown host error';
  }

  private decodeContractError(
    contractAddress: string,
    method: string,
  ): string {
    return `Contract error on ${contractAddress}.${method}`;
  }

  private extractContractErrorCode(
    error?: string,
    events?: xdr.DiagnosticEvent[],
  ): number | undefined {
    const match = error?.match(/Error\(Contract, #(\d+)\)/);
    if (match) {
      return Number(match[1]);
    }
    try {
      for (const diagnosticEvent of events ?? []) {
        const data = diagnosticEvent.event().body().v0().data();
        if (!data || data.switch().name !== 'scvError') {
          continue;
        }
        const scError = data.error();
        if (scError.switch().name !== 'sceContract') {
          continue;
        }
        return Number(scError.contractCode());
      }
    } catch (decodeError) {
      this.logger.warn(
        `extractContractErrorCode: failed to decode contract error code from diagnostic events: ` +
          `${decodeError instanceof Error ? decodeError.message : decodeError}`,
        { error, decodeError },
      );
    }
    return undefined;
  }

  getSorobanRpc(): rpc.Server {
    return this.sorobanRpc;
  }

  /**
   * Gracefully shut down the ContractService.
   *
   * Steps:
   * 1. Set the shutdown flag so sendTransaction() refuses new submissions.
   * 2. Wait for all in-flight pollTransactionConfirmation() calls to settle
   *    (SUCCESS, FAILED, or timeout). This prevents leaving blockchain
   *    transactions in an indeterminate state and keeps the Redis nonce mirror
   *    consistent (rollbacks for failed/timed-out transactions are still
   *    performed by the polling loop itself before it resolves/rejects).
   *
   * Called automatically by NestJS when app.enableShutdownHooks() is active
   * and the process receives SIGTERM/SIGINT.
   */
  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;

    if (this.inFlightTransactions.size > 0) {
      this.logger.log(
        `ContractService: waiting for ${this.inFlightTransactions.size} in-flight transaction(s) to settle`,
      );
      await Promise.allSettled([...this.inFlightTransactions]);
      this.logger.log('ContractService: all in-flight transactions settled');
    } else {
      this.logger.log('ContractService: no in-flight transactions on shutdown');
    }
  }
}
