import { InjectionToken } from '@angular/core';
import { isConnected, getAddress, signTransaction } from '@stellar/freighter-api';

/** Error envelope every `@stellar/freighter-api` call may return alongside its payload. */
export interface FreighterApiError {
  code: number;
  message: string;
}

/**
 * The slice of `@stellar/freighter-api` the wallet service uses. It is injected
 * rather than imported directly so a test harness can provide a stub through
 * TestBed and simulate a browser where the extension is absent.
 */
export interface FreighterApi {
  isConnected(): Promise<{ isConnected: boolean; error?: FreighterApiError }>;
  getAddress(): Promise<{ address: string; error?: FreighterApiError }>;
  signTransaction(
    transactionXdr: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<{ signedTxXdr: string; signerAddress: string; error?: FreighterApiError }>;
}

export const FREIGHTER_API = new InjectionToken<FreighterApi>('FREIGHTER_API', {
  providedIn: 'root',
  factory: () => ({ isConnected, getAddress, signTransaction }),
});

/**
 * `window` as Freighter leaves it: the extension's content script sets
 * `window.freighter` once it has run, and Brave adds `navigator.brave`.
 */
export type FreighterWindow = Window & {
  freighter?: boolean;
  navigator: Navigator & { brave?: unknown };
};

export const BROWSER_WINDOW = new InjectionToken<FreighterWindow>('BROWSER_WINDOW', {
  providedIn: 'root',
  factory: () => window as FreighterWindow,
});
