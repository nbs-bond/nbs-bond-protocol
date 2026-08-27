import { Injectable, HttpException, HttpStatus, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  Horizon,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

interface StreamState {
  publicKey: string;
  onPayment: (payment: Horizon.ServerApi.PaymentOperationRecord) => void;
  cursor?: string;
  closeFn: (() => void) | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

@Injectable()
export class StellarService implements OnModuleDestroy {
  private readonly logger = new Logger(StellarService.name);
  private horizon: Horizon.Server;
  private networkPassphrase: string;
  private accountCache: Map<string, CacheEntry<Horizon.AccountResponse>> = new Map();
  private readonly CACHE_TTL_MS = 30_000;
  private streamState: StreamState | null = null;

  constructor() {
    this.horizon = new Horizon.Server(
      process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
    );
    this.networkPassphrase = process.env.STELLAR_NETWORK === 'mainnet'
      ? Networks.PUBLIC
      : Networks.TESTNET;
  }

  async getAccount(publicKey: string): Promise<Horizon.AccountResponse> {
    const cached = this.accountCache.get(publicKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }
    try {
      const account = await this.horizon.loadAccount(publicKey);
      this.accountCache.set(publicKey, {
        data: account,
        expiresAt: Date.now() + this.CACHE_TTL_MS,
      });
      return account;
    } catch (error) {
      throw new HttpException(
        `Failed to load account ${publicKey}: ${error.message}`,
        HttpStatus.NOT_FOUND,
      );
    }
  }

  async getBalance(publicKey: string): Promise<string> {
    const account = await this.getAccount(publicKey);
    const native = account.balances.find(
      (b): b is Horizon.HorizonApi.BalanceLineNative => b.asset_type === 'native',
    );
    return native?.balance ?? '0';
  }

  async getBalances(publicKey: string): Promise<Horizon.HorizonApi.BalanceLine[]> {
    const account = await this.getAccount(publicKey);
    return account.balances;
  }

  async submitTransaction(
    txEnvelope: string,
  ): Promise<Horizon.HorizonApi.SubmitTransactionResponse> {
    try {
      const transaction = TransactionBuilder.fromXDR(txEnvelope, 'base64');
      return await this.horizon.submitTransaction(transaction);
    } catch (error) {
      throw new HttpException(
        `Transaction submission failed: ${error.message}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  streamPayments(
    publicKey: string,
    onPayment: (payment: Horizon.ServerApi.PaymentOperationRecord) => void,
    cursor?: string,
  ): () => void {
    this.closePaymentStream();

    this.streamState = {
      publicKey,
      onPayment,
      cursor,
      closeFn: null,
      reconnectTimer: null,
      backoffMs: INITIAL_BACKOFF_MS,
    };

    this.openPaymentStream(this.streamState);

    return () => this.closePaymentStream();
  }

  private openPaymentStream(state: StreamState): void {
    const builder = this.horizon
      .payments()
      .forAccount(state.publicKey);

    if (state.cursor) {
      builder.cursor(state.cursor);
    }

    state.closeFn = builder.stream({
      onmessage: (value) => {
        state.backoffMs = INITIAL_BACKOFF_MS;
        state.onPayment(value as unknown as Horizon.ServerApi.PaymentOperationRecord);
      },
      onerror: (event) => {
        this.logger.error(
          `Payment stream error for ${state.publicKey}: ${event.data ?? 'unknown error'}`,
        );
        this.closeCurrentStream(state);
        this.scheduleReconnect(state);
      },
    });
  }

  private closeCurrentStream(state: StreamState): void {
    if (state.closeFn) {
      state.closeFn();
      state.closeFn = null;
    }
  }

  private scheduleReconnect(state: StreamState): void {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
    }

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (this.streamState === state) {
        this.logger.log(
          `Reconnecting payment stream for ${state.publicKey} after ${state.backoffMs}ms`,
        );
        this.openPaymentStream(state);
      }
    }, state.backoffMs);

    state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private closePaymentStream(): void {
    if (!this.streamState) {
      return;
    }

    const state = this.streamState;

    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    this.closeCurrentStream(state);
    this.streamState = null;
  }

  isPaymentStreamActive(): boolean {
    return this.streamState != null && this.streamState.closeFn != null;
  }

  getKeypairFromSecret(secretKey: string): Keypair {
    return Keypair.fromSecret(secretKey);
  }

  generateKeypair(): { publicKey: string; secretKey: string } {
    const keypair = Keypair.random();
    return {
      publicKey: keypair.publicKey(),
      secretKey: keypair.secret(),
    };
  }

  isValidPublicKey(address: string): boolean {
    return StrKey.isValidEd25519PublicKey(address);
  }

  getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }

  async accountExists(publicKey: string): Promise<boolean> {
    try {
      await this.getAccount(publicKey);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close any open Horizon payment SSE stream when the module is torn down.
   * Called automatically by NestJS when app.enableShutdownHooks() is active
   * and the process receives SIGTERM/SIGINT.
   */
  onModuleDestroy(): void {
    this.closePaymentStream();
  }
}
