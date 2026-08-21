import { Injectable, inject, signal, computed } from '@angular/core';
import { BROWSER_WINDOW, FREIGHTER_API, FreighterApiError } from './freighter.tokens';
import { environment } from '../../environments/environment';

export type WalletErrorKind =
  /** No Freighter extension in this browser — the user needs an install prompt. */
  | 'not-installed'
  /** Freighter is installed but the user dismissed one of its prompts. */
  | 'rejected'
  /** Freighter is installed and answered, but the request failed. */
  | 'unavailable';

export class WalletError extends Error {
  constructor(readonly kind: WalletErrorKind, message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

/**
 * The extension injects `window.freighter` from a content script after page
 * load, so one synchronous check can lose the race on a slow start-up. Poll a
 * few times across roughly a second before concluding it is absent.
 */
const DETECTION_ATTEMPTS = 3;
const DETECTION_INTERVAL_MS = 350;

/** Freighter reports a prompt the user dismissed with this code. */
const DECLINED_CODE = -4;

function isDeclined(error: FreighterApiError): boolean {
  return error.code === DECLINED_CODE || /declin|reject|denied/i.test(error.message ?? '');
}

@Injectable({ providedIn: 'root' })
export class WalletService {
  private readonly freighter = inject(FREIGHTER_API);
  private readonly window = inject(BROWSER_WINDOW);

  readonly address = signal<string | null>(null);
  readonly isConnected = signal(false);
  readonly isConnecting = signal(false);
  readonly error = signal<WalletError | null>(null);

  /** True when the failure was a missing extension, so the UI can offer an install link. */
  readonly needsInstall = computed(() => this.error()?.kind === 'not-installed');

  /**
   * Resolves `true` once the wallet is connected. Never rejects: failures are
   * published on `error()` so callers in templates cannot leave the user with a
   * silently swallowed rejection.
   */
  async connect(): Promise<boolean> {
    this.isConnecting.set(true);
    this.error.set(null);
    try {
      if (!(await this.detect())) {
        throw new WalletError('not-installed', 'Freighter wallet extension not detected.');
      }

      const { address, error } = await this.guard(
        () => this.freighter.getAddress(),
        'Freighter could not share your address.',
      );
      if (error) throw this.toWalletError(error, 'Freighter could not share your address.');
      if (!address) throw new WalletError('rejected', 'The connection request was declined.');

      this.address.set(address);
      this.isConnected.set(true);
      return true;
    } catch (e) {
      this.address.set(null);
      this.isConnected.set(false);
      this.error.set(this.asWalletError(e));
      return false;
    } finally {
      this.isConnecting.set(false);
    }
  }

  /**
   * Signs the auth challenge. Rejects with a {@link WalletError} so the caller can
   * tell a declined prompt apart from an extension that stopped responding.
   */
  async signChallenge(challenge: string): Promise<string> {
    this.error.set(null);
    try {
      const { signedTxXdr, error } = await this.guard(
        () =>
          this.freighter.signTransaction(challenge, {
            networkPassphrase: environment.networkPassphrase,
          }),
        'Freighter could not sign the challenge.',
      );
      if (error) throw this.toWalletError(error, 'Freighter could not sign the challenge.');
      if (!signedTxXdr) throw new WalletError('rejected', 'The signature request was declined.');

      return signedTxXdr;
    } catch (e) {
      const walletError = this.asWalletError(e);
      this.error.set(walletError);
      throw walletError;
    }
  }

  disconnect(): void {
    this.address.set(null);
    this.isConnected.set(false);
    this.error.set(null);
  }

  /**
   * Waits for `window.freighter` to appear, then falls back to the API's own
   * probe, which messages the content script and resolves false when nothing
   * answers. Freighter builds that never set the flag still connect this way.
   */
  private async detect(): Promise<boolean> {
    for (let attempt = 1; attempt <= DETECTION_ATTEMPTS; attempt++) {
      if (this.window.freighter) return true;
      if (attempt < DETECTION_ATTEMPTS) await this.delay(DETECTION_INTERVAL_MS);
    }

    try {
      const { isConnected, error } = await this.freighter.isConnected();
      return isConnected && !error;
    } catch {
      return false;
    }
  }

  /** Freighter calls can reject outright, not only return an `error` — treat both alike. */
  private async guard<T>(call: () => Promise<T>, message: string): Promise<T> {
    try {
      return await call();
    } catch {
      throw new WalletError('unavailable', message);
    }
  }

  private toWalletError(error: FreighterApiError, fallback: string): WalletError {
    return isDeclined(error)
      ? new WalletError('rejected', 'You declined the Freighter request.')
      : new WalletError('unavailable', error.message || fallback);
  }

  private asWalletError(e: unknown): WalletError {
    if (e instanceof WalletError) return e;
    const message = e instanceof Error ? e.message : 'Wallet connection failed.';
    return new WalletError('unavailable', message);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => this.window.setTimeout(resolve, ms));
  }
}
