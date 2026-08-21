/**
 * Unit tests for StellarService — payment stream error handling & reconnection.
 *
 * Covers: onerror handler logging, exponential backoff reconnection,
 * duplicate stream prevention, and paymentStreamActive status.
 */

import { Logger } from '@nestjs/common';

// ─── Stellar SDK mock ────────────────────────────────────────────────────────

let streamMock: jest.Mock;
let paymentsForAccountBuilder: any;

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        payments: jest.fn().mockReturnValue({
          forAccount: jest.fn().mockImplementation(() => {
            paymentsForAccountBuilder = {
              cursor: jest.fn().mockReturnThis(),
              stream: streamMock,
            };
            return paymentsForAccountBuilder;
          }),
        }),
        loadAccount: jest.fn().mockResolvedValue({
          sequence: '0',
          balances: [{ asset_type: 'native', balance: '100' }],
        }),
        submitTransaction: jest.fn(),
      })),
    },
  };
});

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { StellarService } from './stellar.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createStreamMock() {
  const closeFn = jest.fn();
  streamMock = jest.fn().mockReturnValue(closeFn);
  return closeFn;
}

function createErrorEvent(data?: string): { data?: string } {
  return { data: data ?? 'connection lost' };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('StellarService — payment stream', () => {
  let service: StellarService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    createStreamMock();
    service = new StellarService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Basic stream lifecycle ────────────────────────────────────────────────

  describe('streamPayments', () => {
    it('opens a stream and returns a close function', () => {
      const onPayment = jest.fn();
      const close = service.streamPayments('GBKEY', onPayment);

      expect(streamMock).toHaveBeenCalledTimes(1);
      expect(typeof close).toBe('function');
    });

    it('passes onmessage to the SDK stream', () => {
      const onPayment = jest.fn();
      service.streamPayments('GBKEY', onPayment);

      const options = streamMock.mock.calls[0][0];
      expect(options.onmessage).toBeDefined();
      expect(options.onerror).toBeDefined();
    });

    it('forwards onmessage values to the onPayment callback', () => {
      const onPayment = jest.fn();
      service.streamPayments('GBKEY', onPayment);

      const options = streamMock.mock.calls[0][0];
      const fakePayment = { id: '1', type: 'payment' };
      options.onmessage(fakePayment);

      expect(onPayment).toHaveBeenCalledWith(fakePayment);
    });

    it('sets cursor when provided', () => {
      const onPayment = jest.fn();
      service.streamPayments('GBKEY', onPayment, '123');

      expect(paymentsForAccountBuilder.cursor).toHaveBeenCalledWith('123');
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────

  describe('onerror handler', () => {
    it('logs the error when the stream emits an error', () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const onPayment = jest.fn();
      service.streamPayments('GBKEY', onPayment);

      const options = streamMock.mock.calls[0][0];
      options.onerror(createErrorEvent('timeout'));

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Payment stream error for GBKEY'),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('timeout'),
      );
      errorSpy.mockRestore();
    });

    it('logs "unknown error" when event data is absent', () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const onPayment = jest.fn();
      service.streamPayments('GBKEY', onPayment);

      const options = streamMock.mock.calls[0][0];
      options.onerror({});

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('unknown error'),
      );
      errorSpy.mockRestore();
    });
  });

  // ── Reconnection with exponential backoff ─────────────────────────────────

  describe('reconnection', () => {
    it('reconnects after 1s on first error', () => {
      const onPayment = jest.fn();
      service.streamPayments('GBKEY', onPayment);

      expect(streamMock).toHaveBeenCalledTimes(1);

      const options = streamMock.mock.calls[0][0];
      options.onerror(createErrorEvent('err'));

      jest.advanceTimersByTime(1_000);

      expect(streamMock).toHaveBeenCalledTimes(2);
    });

    it('uses exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap)', () => {
      const onPayment = jest.fn();
      service.streamPayments('GBKEY', onPayment);

      const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

      for (const delay of expectedDelays) {
        const options = streamMock.mock.calls[streamMock.mock.calls.length - 1][0];
        options.onerror(createErrorEvent('err'));

        jest.advanceTimersByTime(delay);

        expect(streamMock).toHaveBeenCalledTimes(
          expectedDelays.indexOf(delay) + 2,
        );
      }
    });

    it('resets backoff after a successful message', () => {
      const onPayment = jest.fn();
      service.streamPayments('GBKEY', onPayment);

      // Trigger error → 1s backoff
      let options = streamMock.mock.calls[0][0];
      options.onerror(createErrorEvent('err'));
      jest.advanceTimersByTime(1_000);
      expect(streamMock).toHaveBeenCalledTimes(2);

      // Successful message resets backoff
      options = streamMock.mock.calls[1][0];
      options.onmessage({ id: '1' });

      // Next error should use 1s again (not 2s)
      options.onerror(createErrorEvent('err'));
      jest.advanceTimersByTime(1_000);
      expect(streamMock).toHaveBeenCalledTimes(3);
    });

    it('does not reconnect if a new stream has replaced the old one', () => {
      const onPayment1 = jest.fn();
      const onPayment2 = jest.fn();

      service.streamPayments('GBKEY1', onPayment1);

      const options1 = streamMock.mock.calls[0][0];
      options1.onerror(createErrorEvent('err'));

      // Start a new stream before reconnect fires
      service.streamPayments('GBKEY2', onPayment2);
      jest.advanceTimersByTime(1_000);

      // Only 2 streams: the original GBKEY1 and the new GBKEY2.
      // The stale GBKEY1 reconnect should NOT have fired.
      expect(streamMock).toHaveBeenCalledTimes(2);
      expect(service['streamState']?.publicKey).toBe('GBKEY2');
    });
  });

  // ── Close / cleanup ──────────────────────────────────────────────────────

  describe('closePaymentStream', () => {
    it('closes the active stream and clears reconnect timer', () => {
      const onPayment = jest.fn();
      const closeFn = service.streamPayments('GBKEY', onPayment);

      const options = streamMock.mock.calls[0][0];
      options.onerror(createErrorEvent('err'));

      closeFn();

      // Timer fires but should not reconnect
      jest.advanceTimersByTime(1_000);
      expect(streamMock).toHaveBeenCalledTimes(1);
    });

    it('calling close twice does not throw', () => {
      const closeFn = service.streamPayments('GBKEY', jest.fn());
      closeFn();
      expect(() => closeFn()).not.toThrow();
    });
  });

  // ── isPaymentStreamActive ────────────────────────────────────────────────

  describe('isPaymentStreamActive', () => {
    it('returns false when no stream is open', () => {
      expect(service.isPaymentStreamActive()).toBe(false);
    });

    it('returns true after streamPayments is called', () => {
      service.streamPayments('GBKEY', jest.fn());
      expect(service.isPaymentStreamActive()).toBe(true);
    });

    it('returns false after the stream is closed', () => {
      const closeFn = service.streamPayments('GBKEY', jest.fn());
      expect(service.isPaymentStreamActive()).toBe(true);
      closeFn();
      expect(service.isPaymentStreamActive()).toBe(false);
    });

    it('returns false after an error while reconnecting, then true once reconnected', () => {
      service.streamPayments('GBKEY', jest.fn());
      expect(service.isPaymentStreamActive()).toBe(true);

      // Error → closeFn is nulled
      const options = streamMock.mock.calls[0][0];
      options.onerror(createErrorEvent('err'));
      expect(service.isPaymentStreamActive()).toBe(false);

      // Reconnect → closeFn is set again
      jest.advanceTimersByTime(1_000);
      expect(service.isPaymentStreamActive()).toBe(true);
    });
  });

  // ── Account & Helper Utilities ──────────────────────────────────────────

  describe('account & utility methods', () => {
    it('getAccount fetches account from horizon server and caches result', async () => {
      const account = await service.getAccount('GBKEY');
      expect(account).toEqual({
        sequence: '0',
        balances: [{ asset_type: 'native', balance: '100' }],
      });

      // Second call should return cached object without invoking horizon again
      const cachedAccount = await service.getAccount('GBKEY');
      expect(cachedAccount).toBe(account);
    });

    it('getAccount throws HttpException if horizon fails to load account', async () => {
      (service['horizon'].loadAccount as jest.Mock).mockRejectedValueOnce(new Error('Account not found'));
      await expect(service.getAccount('GNOTFOUND')).rejects.toThrow('Failed to load account GNOTFOUND');
    });

    it('getBalance returns native balance of account', async () => {
      const balance = await service.getBalance('GBKEY');
      expect(balance).toBe('100');
    });

    it('getBalances returns array of balances', async () => {
      const balances = await service.getBalances('GBKEY');
      expect(balances).toEqual([{ asset_type: 'native', balance: '100' }]);
    });

    it('generateKeypair returns a valid Stellar keypair', () => {
      const pair = service.generateKeypair();
      expect(service.isValidPublicKey(pair.publicKey)).toBe(true);
      expect(pair.secretKey.startsWith('S')).toBe(true);
    });

    it('isValidPublicKey identifies valid and invalid public keys', () => {
      const pair = service.generateKeypair();
      expect(service.isValidPublicKey(pair.publicKey)).toBe(true);
      expect(service.isValidPublicKey('INVALID')).toBe(false);
    });

    it('getNetworkPassphrase returns configured network passphrase', () => {
      expect(typeof service.getNetworkPassphrase()).toBe('string');
    });

    it('accountExists returns true if account is found and false otherwise', async () => {
      expect(await service.accountExists('GBKEY')).toBe(true);
      (service['horizon'].loadAccount as jest.Mock).mockRejectedValueOnce(new Error('Not found'));
      expect(await service.accountExists('GNOTFOUND')).toBe(false);
    });
  });
});

