/**
 * Unit tests for ContractService.
 *
 * Covers the transaction confirmation polling flow introduced to fix the
 * nonce-divergence bug (#89).  The Stellar SDK rpc.Server, StellarService,
 * and NonceService are all mocked — no network calls are made.
 */

import {
  xdr,
  nativeToScVal,
  scValToNative,
  Keypair,
  TransactionBuilder,
  Account,
  Contract,
  Address,
  BASE_FEE,
} from '@stellar/stellar-sdk';

// ─── Stellar SDK mock ────────────────────────────────────────────────────────

const simulateTransactionMock = jest.fn();
const prepareTransactionMock = jest.fn();
const sorobanSendTransactionMock = jest.fn();
const getTransactionMock = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn().mockImplementation(() => ({
        simulateTransaction: simulateTransactionMock,
        prepareTransaction: prepareTransactionMock,
        sendTransaction: sorobanSendTransactionMock,
        getTransaction: getTransactionMock,
      })),
      Api: {
        ...actual.rpc.Api,
        isSimulationError: actual.rpc.Api.isSimulationError,
      },
    },
  };
});

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { ContractService } from './contract.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const SECRET = Keypair.random().secret();
const PUBLIC = Keypair.fromSecret(SECRET).publicKey();
const METHOD = 'issue_bond';

function buildSuccessfulSimulation(retval: xdr.ScVal) {
  return {
    id: 'simulate-tx',
    transaction: { fee: '100', ...{} },
    result: { retval, auth: [] },
    events: [],
  };
}

function buildSubmittedResponse(hash: string) {
  return { status: 'PENDING' as const, hash, errorResult: undefined };
}

function buildSuccessTxResponse(retval?: xdr.ScVal) {
  const scVal = retval ?? nativeToScVal(BigInt(42), { type: 'u64' });
  return {
    status: 'SUCCESS' as const,
    hash: 'tx-hash-123',
    ledger: 100,
    createdAt: '2024-01-01T00:00:00Z',
    resultMetaXdr: {
      v3: jest.fn().mockReturnValue({
        sorobanMeta: jest.fn().mockReturnValue({
          returnValue: jest.fn().mockReturnValue(scVal),
        }),
      }),
    },
  };
}

function buildFailedTxResponse() {
  return {
    status: 'FAILED' as const,
    hash: 'tx-hash-456',
    ledger: 101,
    createdAt: '2024-01-01T00:00:00Z',
    resultXdr: {},
    resultMetaXdr: {},
  };
}

function buildNotFoundResponse() {
  return { status: 'NOT_FOUND' as const };
}

const PASSPHRASE = 'Test SDF Network ; September 2015';

/**
 * Builds a real, signed Transaction envelope (base64 XDR) invoking
 * `method` on `contractId` from `sourceKeypair`, for feeding into
 * submitSignedTransaction()'s decoding/validation logic. Unlike the rest of
 * this file, TransactionBuilder/Account/Contract are NOT mocked — only
 * rpc.Server is — so this exercises the real XDR encode/decode path.
 */
function buildSignedXdr(opts: {
  sourceKeypair: Keypair;
  contractId: string;
  method: string;
  args?: xdr.ScVal[];
  operationCount?: number;
}): string {
  const account = new Account(opts.sourceKeypair.publicKey(), '100');
  const contract = new Contract(opts.contractId);
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  });
  const operationCount = opts.operationCount ?? 1;
  for (let i = 0; i < operationCount; i++) {
    builder.addOperation(contract.call(opts.method, ...(opts.args ?? [])));
  }
  const transaction = builder.setTimeout(30).build();
  transaction.sign(opts.sourceKeypair);
  return transaction.toXDR();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ContractService', () => {
  let service: ContractService;
  let stellarServiceMock: any;
  let nonceServiceMock: any;

  beforeEach(() => {
    jest.useFakeTimers();

    // clearAllMocks keeps the rpc.Server mock implementation intact (unlike
    // resetAllMocks which would null-out the Server constructor).  We also
    // manually clear the specific mock queues to prevent leakage between tests.
    jest.clearAllMocks();
    simulateTransactionMock.mockReset();
    prepareTransactionMock.mockReset();
    sorobanSendTransactionMock.mockReset();
    getTransactionMock.mockReset();

    stellarServiceMock = {
      getAccount: jest.fn().mockResolvedValue({ sequence: '0' }),
      getNetworkPassphrase: jest.fn().mockReturnValue('Test SDF Network ; September 2015'),
    };

    nonceServiceMock = {
      next: jest.fn().mockResolvedValue(0),
      rollback: jest.fn().mockResolvedValue(-1),
    };

    service = new ContractService(stellarServiceMock, nonceServiceMock);

    // Defaults: simulation succeeds with void, prepare passes through.
    simulateTransactionMock.mockResolvedValue(
      buildSuccessfulSimulation(xdr.ScVal.scvVoid()),
    );
    prepareTransactionMock.mockImplementation((tx) => Promise.resolve(tx));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── sendTransaction — SUCCESS path ─────────────────────────────────────────

  describe('sendTransaction — SUCCESS', () => {
    it('polls getTransaction and does not return until SUCCESS is confirmed', async () => {
      getTransactionMock
        .mockResolvedValueOnce(buildNotFoundResponse())
        .mockResolvedValueOnce(buildSuccessTxResponse());
      sorobanSendTransactionMock.mockResolvedValue(buildSubmittedResponse('tx-hash-123'));

      const promise = service.sendTransaction({
        contractAddress: CONTRACT,
        method: METHOD,
        args: [],
        sourceSecretKey: SECRET,
      });

      // First poll fires after 1 s. getTransaction returns NOT_FOUND.
      // Backoff doubles to 2 s. Second poll fires after 2 more seconds.
      await jest.advanceTimersByTimeAsync(4_000);

      const result = await promise;

      expect(result.successful).toBe(true);
      expect(result.transactionHash).toBe('tx-hash-123');
      expect(getTransactionMock).toHaveBeenCalledTimes(2);
      expect(nonceServiceMock.rollback).not.toHaveBeenCalled();
    });

    it('returns the on-chain retval from getTransaction metadata, not simulation', async () => {
      const onChainRetVal = nativeToScVal(BigInt(999), { type: 'u64' });
      getTransactionMock.mockResolvedValueOnce(buildSuccessTxResponse(onChainRetVal));
      sorobanSendTransactionMock.mockResolvedValue(buildSubmittedResponse('tx-hash-789'));

      const promise = service.sendTransaction({
        contractAddress: CONTRACT,
        method: METHOD,
        args: [],
        sourceSecretKey: SECRET,
      });

      await jest.advanceTimersByTimeAsync(2_000);
      const result = await promise;

      // 999 from on-chain, NOT void from simulation.
      expect(scValToNative(result.result)).toBe(BigInt(999));
    });
  });

  // ── sendTransaction — FAILED path ──────────────────────────────────────────

  describe('sendTransaction — FAILED', () => {
    it('rolls back the nonce and throws BadRequestException on FAILED', async () => {
      getTransactionMock.mockResolvedValueOnce(buildFailedTxResponse());
      sorobanSendTransactionMock.mockResolvedValue(buildSubmittedResponse('tx-hash-456'));

      let caughtError: any;
      const promise = service.sendTransaction({
        contractAddress: CONTRACT,
        method: METHOD,
        args: [],
        sourceSecretKey: SECRET,
      }).catch((err) => { caughtError = err; });

      await jest.advanceTimersByTimeAsync(2_000);
      await promise;

      expect(caughtError).toMatchObject({
        status: 400,
        message: expect.stringContaining('failed on-chain'),
      });
      expect(nonceServiceMock.rollback).toHaveBeenCalledWith(CONTRACT, PUBLIC);
    });

    it('still throws even if rollback itself fails', async () => {
      getTransactionMock.mockResolvedValueOnce(buildFailedTxResponse());
      sorobanSendTransactionMock.mockResolvedValue(buildSubmittedResponse('tx-hash-456'));
      nonceServiceMock.rollback.mockRejectedValueOnce(new Error('redis down'));

      let caughtError: any;
      const promise = service.sendTransaction({
        contractAddress: CONTRACT,
        method: METHOD,
        args: [],
        sourceSecretKey: SECRET,
      }).catch((err) => { caughtError = err; });

      await jest.advanceTimersByTimeAsync(2_000);
      await promise;

      expect(caughtError).toMatchObject({
        status: 400,
        message: expect.stringContaining('failed on-chain'),
      });
    });
  });

  // ── sendTransaction — timeout path ─────────────────────────────────────────

  describe('sendTransaction — timeout', () => {
    it('rolls back the nonce and throws 504 GatewayTimeout after TX_CONFIRM_TIMEOUT_MS', async () => {
      getTransactionMock.mockResolvedValue(buildNotFoundResponse());
      sorobanSendTransactionMock.mockResolvedValue(buildSubmittedResponse('tx-hash-timeout'));

      let caughtError: any;
      const promise = service.sendTransaction({
        contractAddress: CONTRACT,
        method: METHOD,
        args: [],
        sourceSecretKey: SECRET,
      }).catch((err) => { caughtError = err; });

      // Default timeout is 30 s. Advance past that.
      await jest.advanceTimersByTimeAsync(35_000);
      await promise;

      expect(caughtError).toMatchObject({
        status: 504,
        message: expect.stringContaining('timed out'),
      });
      expect(nonceServiceMock.rollback).toHaveBeenCalledWith(CONTRACT, PUBLIC);
    });
  });

  // ── sendTransaction — submission ERROR ─────────────────────────────────────

  describe('sendTransaction — submission ERROR', () => {
    it('throws BadRequestException immediately on sendTransaction ERROR status', async () => {
      sorobanSendTransactionMock.mockResolvedValue({
        status: 'ERROR',
        hash: '',
        errorResult: {},
      });

      await expect(
        service.sendTransaction({
          contractAddress: CONTRACT,
          method: METHOD,
          args: [],
          sourceSecretKey: SECRET,
        }),
      ).rejects.toMatchObject({ status: 400 });

      expect(getTransactionMock).not.toHaveBeenCalled();
    });
  });

  // ── sendTransaction — missing sourceSecretKey ──────────────────────────────

  describe('sendTransaction — missing sourceSecretKey', () => {
    it('throws BadRequestException when sourceSecretKey is omitted', async () => {
      await expect(
        service.sendTransaction({
          contractAddress: CONTRACT,
          method: METHOD,
          args: [],
        }),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('sourceSecretKey is required'),
      });
    });
  });

  // ── pollTransactionConfirmation — RPC error resilience ─────────────────────

  describe('pollTransactionConfirmation — RPC errors during polling', () => {
    it('retries when getTransaction throws and eventually succeeds', async () => {
      getTransactionMock
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValueOnce(buildSuccessTxResponse());
      sorobanSendTransactionMock.mockResolvedValue(buildSubmittedResponse('tx-hash-retry'));

      const promise = service.sendTransaction({
        contractAddress: CONTRACT,
        method: METHOD,
        args: [],
        sourceSecretKey: SECRET,
      });

      // First poll at 1 s: getTransaction throws → backs off to 2 s.
      // Second poll at 1+2=3 s: getTransaction succeeds.
      await jest.advanceTimersByTimeAsync(4_000);

      const result = await promise;
      expect(result.successful).toBe(true);
      expect(getTransactionMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── sendTransaction — simulation error ─────────────────────────────────────

  describe('sendTransaction — simulation error', () => {
    it('throws BadRequestException on simulation failure before submission', async () => {
      simulateTransactionMock.mockResolvedValue({
        id: 'sim-fail',
        error: 'Error(Contract, #3)',
        events: [],
      });

      await expect(
        service.sendTransaction({
          contractAddress: CONTRACT,
          method: METHOD,
          args: [],
          sourceSecretKey: SECRET,
        }),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('simulation failed'),
      });

      expect(sorobanSendTransactionMock).not.toHaveBeenCalled();
    });
  });

  // ── extractReturnValue ─────────────────────────────────────────────────────

  describe('extractReturnValue', () => {
    it('extracts returnValue from successful Soroban meta', () => {
      const retval = nativeToScVal(BigInt(77), { type: 'u64' });
      const response = buildSuccessTxResponse(retval);
      const result = (service as any).extractReturnValue(response, CONTRACT, METHOD);
      expect(scValToNative(result)).toBe(BigInt(77));
    });

    it('returns scvVoid (without warning) for a method that genuinely returns void', () => {
      const response = {
        status: 'SUCCESS' as const,
        hash: 'tx-hash-void',
        ledger: 100,
        createdAt: '2024-01-01T00:00:00Z',
        resultMetaXdr: {
          v3: jest.fn().mockReturnValue({
            sorobanMeta: jest.fn().mockReturnValue({
              returnValue: jest.fn().mockReturnValue(undefined),
            }),
          }),
        },
      };
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
      const result = (service as any).extractReturnValue(response, CONTRACT, METHOD);
      expect(result.switch().name).toBe('scvVoid');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('returns scvVoid for non-SUCCESS status', () => {
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
      const result = (service as any).extractReturnValue(
        { status: 'NOT_FOUND' },
        CONTRACT,
        METHOD,
      );
      expect(result.switch().name).toBe('scvVoid');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('logs a WARN (not a silent void) when meta extraction throws', () => {
      const brokenResponse = {
        status: 'SUCCESS',
        resultMetaXdr: {
          v3: () => {
            throw new Error('ABI mismatch');
          },
        },
      };
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

      const result = (service as any).extractReturnValue(brokenResponse, CONTRACT, METHOD);

      expect(result.switch().name).toBe('scvVoid');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message, meta] = warnSpy.mock.calls[0];
      expect(message).toContain('ABI mismatch');
      expect(message).toContain(CONTRACT);
      expect(message).toContain(METHOD);
      expect(meta).toMatchObject({ contractAddress: CONTRACT, method: METHOD });
      warnSpy.mockRestore();
    });
  });

  // ── invokeContractMethod — pass-through ────────────────────────────────────

  describe('invokeContractMethod', () => {
    it('appends the nonce as the last argument and delegates to sendTransaction', async () => {
      getTransactionMock.mockResolvedValue(buildSuccessTxResponse());
      sorobanSendTransactionMock.mockResolvedValue(buildSubmittedResponse('tx-hash-invoke'));

      const arg = nativeToScVal(BigInt(1), { type: 'u64' });
      const promise = service.invokeContractMethod(
        CONTRACT, METHOD, SECRET, [arg], 5,
      );

      await jest.advanceTimersByTimeAsync(2_000);
      const result = await promise;

      expect(result.successful).toBe(true);
      expect(prepareTransactionMock).toHaveBeenCalled();
    });
  });

  // ── prepareTransaction ─────────────────────────────────────────────────────

  describe('prepareTransaction', () => {
    it('returns an unsigned XDR and echoes back the reserved nonce, without signing', async () => {
      const arg = nativeToScVal(BigInt(1), { type: 'u64' });

      const result = await service.prepareTransaction(
        CONTRACT, METHOD, PUBLIC, [arg], 7,
      );

      expect(result.nonce).toBe(7);
      expect(typeof result.xdr).toBe('string');
      expect(result.xdr.length).toBeGreaterThan(0);

      // The returned envelope must be unsigned: decoding it should show no
      // signatures, proving prepareTransaction() never calls .sign().
      const { TransactionBuilder: RealBuilder } = jest.requireActual('@stellar/stellar-sdk');
      const decoded = RealBuilder.fromXDR(result.xdr, PASSPHRASE);
      expect(decoded.signatures.length).toBe(0);

      expect(stellarServiceMock.getAccount).toHaveBeenCalledWith(PUBLIC);
      expect(prepareTransactionMock).toHaveBeenCalled();
    });

    it('appends the nonce as the final contract-call argument', async () => {
      const arg = nativeToScVal(BigInt(1), { type: 'u64' });

      const result = await service.prepareTransaction(
        CONTRACT, METHOD, PUBLIC, [arg], 42,
      );

      const { TransactionBuilder: RealBuilder } = jest.requireActual('@stellar/stellar-sdk');
      const decoded = RealBuilder.fromXDR(result.xdr, PASSPHRASE);
      const invokeArgs = decoded.operations[0].func.invokeContract();
      const scArgs = invokeArgs.args();
      const lastArg = scArgs[scArgs.length - 1];
      expect(scValToNative(lastArg)).toBe(BigInt(42));
      expect(Address.fromScAddress(invokeArgs.contractAddress()).toString()).toBe(CONTRACT);
    });

    it('throws BadRequestException on simulation failure before preparing', async () => {
      simulateTransactionMock.mockResolvedValue({
        id: 'sim-fail',
        error: 'Error(Contract, #3)',
        events: [],
      });

      await expect(
        service.prepareTransaction(CONTRACT, METHOD, PUBLIC, [], 0),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('simulation failed'),
      });

      expect(prepareTransactionMock).not.toHaveBeenCalled();
    });

    it('refuses to prepare new transactions once shutting down', async () => {
      (service as any).shuttingDown = true;

      await expect(
        service.prepareTransaction(CONTRACT, METHOD, PUBLIC, [], 0),
      ).rejects.toMatchObject({ status: 503 });

      (service as any).shuttingDown = false;
    });
  });

  // ── submitSignedTransaction ────────────────────────────────────────────────

  describe('submitSignedTransaction', () => {
    const signerKeypair = Keypair.random();
    const signerAddress = signerKeypair.publicKey();

    it('submits a matching signed envelope and returns the confirmed result', async () => {
      const signedXdr = buildSignedXdr({
        sourceKeypair: signerKeypair,
        contractId: CONTRACT,
        method: METHOD,
      });

      getTransactionMock.mockResolvedValueOnce(buildSuccessTxResponse());
      sorobanSendTransactionMock.mockResolvedValue(buildSubmittedResponse('tx-hash-signed'));

      const promise = service.submitSignedTransaction(
        signedXdr, CONTRACT, METHOD, signerAddress,
      );

      await jest.advanceTimersByTimeAsync(2_000);
      const result = await promise;

      expect(result.successful).toBe(true);
      expect(result.transactionHash).toBe('tx-hash-signed');
      // No signing happens server-side for this path.
      expect(prepareTransactionMock).not.toHaveBeenCalled();
    });

    it('rejects when the envelope source account does not match the expected signer', async () => {
      const otherKeypair = Keypair.random();
      const signedXdr = buildSignedXdr({
        sourceKeypair: signerKeypair,
        contractId: CONTRACT,
        method: METHOD,
      });

      await expect(
        service.submitSignedTransaction(signedXdr, CONTRACT, METHOD, otherKeypair.publicKey()),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('does not match'),
      });
      expect(sorobanSendTransactionMock).not.toHaveBeenCalled();
    });

    it('rejects when the envelope targets a different contract address', async () => {
      const otherContract = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
      const signedXdr = buildSignedXdr({
        sourceKeypair: signerKeypair,
        contractId: otherContract,
        method: METHOD,
      });

      await expect(
        service.submitSignedTransaction(signedXdr, CONTRACT, METHOD, signerAddress),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('unexpected contract address'),
      });
      expect(sorobanSendTransactionMock).not.toHaveBeenCalled();
    });

    it('rejects when the envelope targets a different method', async () => {
      const signedXdr = buildSignedXdr({
        sourceKeypair: signerKeypair,
        contractId: CONTRACT,
        method: 'some_other_method',
      });

      await expect(
        service.submitSignedTransaction(signedXdr, CONTRACT, METHOD, signerAddress),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('unexpected contract method'),
      });
      expect(sorobanSendTransactionMock).not.toHaveBeenCalled();
    });

    it('rejects an envelope with more than one operation', async () => {
      const signedXdr = buildSignedXdr({
        sourceKeypair: signerKeypair,
        contractId: CONTRACT,
        method: METHOD,
        operationCount: 2,
      });

      await expect(
        service.submitSignedTransaction(signedXdr, CONTRACT, METHOD, signerAddress),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('exactly one operation'),
      });
      expect(sorobanSendTransactionMock).not.toHaveBeenCalled();
    });

    it('rejects a fee-bump transaction envelope', async () => {
      const account = new Account(signerAddress, '100');
      const contract = new Contract(CONTRACT);
      const inner = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: PASSPHRASE,
      })
        .addOperation(contract.call(METHOD))
        .setTimeout(30)
        .build();
      inner.sign(signerKeypair);

      const feeSource = Keypair.random();
      const feeBump = TransactionBuilder.buildFeeBumpTransaction(
        feeSource, BASE_FEE, inner, PASSPHRASE,
      );
      feeBump.sign(feeSource);

      await expect(
        service.submitSignedTransaction(feeBump.toXDR(), CONTRACT, METHOD, signerAddress),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('Fee-bump'),
      });
      expect(sorobanSendTransactionMock).not.toHaveBeenCalled();
    });

    it('rejects malformed XDR', async () => {
      await expect(
        service.submitSignedTransaction('not-valid-xdr', CONTRACT, METHOD, signerAddress),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('Malformed'),
      });
      expect(sorobanSendTransactionMock).not.toHaveBeenCalled();
    });

    it('refuses to submit new transactions once shutting down', async () => {
      const signedXdr = buildSignedXdr({
        sourceKeypair: signerKeypair,
        contractId: CONTRACT,
        method: METHOD,
      });
      (service as any).shuttingDown = true;

      await expect(
        service.submitSignedTransaction(signedXdr, CONTRACT, METHOD, signerAddress),
      ).rejects.toMatchObject({ status: 503 });

      (service as any).shuttingDown = false;
      expect(sorobanSendTransactionMock).not.toHaveBeenCalled();
    });

    it('rolls back the nonce for the expected source address on a FAILED confirmation', async () => {
      const signedXdr = buildSignedXdr({
        sourceKeypair: signerKeypair,
        contractId: CONTRACT,
        method: METHOD,
      });

      getTransactionMock.mockResolvedValueOnce(buildFailedTxResponse());
      sorobanSendTransactionMock.mockResolvedValue(buildSubmittedResponse('tx-hash-failed'));

      const promise = service.submitSignedTransaction(
        signedXdr, CONTRACT, METHOD, signerAddress,
      ).catch((err) => err);

      await jest.advanceTimersByTimeAsync(2_000);
      const caughtError = await promise;

      expect(caughtError).toMatchObject({ status: 400 });
      expect(nonceServiceMock.rollback).toHaveBeenCalledWith(CONTRACT, signerAddress);
    });
  });
});
