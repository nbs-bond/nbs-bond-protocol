import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { KycService, KycProviderClient, KycCircuitBreaker, HttpKycProviderClient } from './kyc.service';
import { KycStatus } from '../common/interfaces/authenticated-request.interface';

jest.mock('@redis/client', () => {
  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
  return {
    createClient: jest.fn().mockReturnValue(mockClient),
  };
});

import { createClient, RedisClientType } from '@redis/client';

function redisMock(): {
  client: RedisClientType;
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
} {
  const client = createClient() as unknown as {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
  };
  return {
    client: client as unknown as RedisClientType,
    get: client.get,
    set: client.set,
    del: client.del,
  };
}

/** Serialized cache entry as written by KycService.cacheStatus. */
function cachedValue(status: string, cachedAt: string = new Date(0).toISOString()): string {
  return JSON.stringify({ status, cachedAt });
}

class FakeProvider implements KycProviderClient {
  status = KycStatus.VERIFIED;
  failNext = 0;
  healthResult: { status: string; recoverySeconds?: number } | null = null;

  isConfigured(): boolean {
    return true;
  }
  async checkStatus(_address: string): Promise<KycStatus> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('connection refused');
    }
    return this.status;
  }
  async health() {
    return this.healthResult;
  }
}

describe('KycService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getStatus', () => {
    it('serves a fresh cached value without calling the provider', async () => {
      const { client, get } = redisMock();
      const cachedAt = new Date().toISOString();
      get.mockResolvedValueOnce(cachedValue('verified', cachedAt));
      const provider = new FakeProvider();
      const checkSpy = jest.spyOn(provider, 'checkStatus');
      const service = new KycService(provider, new KycCircuitBreaker(3, 30_000));

      const result = await service.getStatus('GABC');

      expect(result).toEqual({ status: KycStatus.VERIFIED, stale: false, cachedAt });
      expect(checkSpy).not.toHaveBeenCalled();
      expect(client.del).not.toHaveBeenCalled();
    });

    it('drops an unrecognized cached value before consulting the provider', async () => {
      const { client, get } = redisMock();
      get.mockResolvedValueOnce('garbage');
      const provider = new FakeProvider();
      const service = new KycService(provider, new KycCircuitBreaker(3, 30_000));

      await service.getStatus('GABC');

      expect(client.del).toHaveBeenCalledWith('kyc:GABC');
    });

    it('fetches from the provider on cache miss and caches with an approved TTL', async () => {
      const { get, set } = redisMock();
      get.mockResolvedValueOnce(null); // fresh cache: miss
      get.mockResolvedValueOnce(null); // stale mirror: miss
      const provider = new FakeProvider();
      const service = new KycService(provider, new KycCircuitBreaker(3, 30_000));

      const result = await service.getStatus('GABC');

      expect(result.status).toBe(KycStatus.VERIFIED);
      expect(result.stale).toBe(false);
      expect(result.cachedAt).toEqual(expect.any(String));

      const [freshKey, freshValue, freshOpts] = set.mock.calls[0];
      expect(freshKey).toBe('kyc:GABC');
      expect(JSON.parse(freshValue).status).toBe('verified');
      expect(freshOpts).toEqual({ EX: 3600 });

      const [staleKey, staleValue] = set.mock.calls[1];
      expect(staleKey).toBe('kyc:GABC:stale');
      expect(JSON.parse(staleValue).status).toBe('verified');
      expect(JSON.parse(staleValue).cachedAt).toBe(result.cachedAt);
    });

    it('caches a pending status with the short TTL', async () => {
      const { get, set } = redisMock();
      get.mockResolvedValueOnce(null);
      get.mockResolvedValueOnce(null);
      const provider = new FakeProvider();
      provider.status = KycStatus.PENDING;
      const service = new KycService(provider, new KycCircuitBreaker(3, 30_000));

      await service.getStatus('GABC');

      const [freshKey, , freshOpts] = set.mock.calls[0];
      expect(freshKey).toBe('kyc:GABC');
      expect(freshOpts).toEqual({ EX: 60 });
    });

    it('caches a rejected/none status with the longer TTL', async () => {
      const { get, set } = redisMock();
      get.mockResolvedValueOnce(null);
      get.mockResolvedValueOnce(null);
      const provider = new FakeProvider();
      provider.status = KycStatus.NONE;
      const service = new KycService(provider, new KycCircuitBreaker(3, 30_000));

      await service.getStatus('GABC');

      const [freshKey, , freshOpts] = set.mock.calls[0];
      expect(freshKey).toBe('kyc:GABC');
      expect(freshOpts).toEqual({ EX: 21600 });
    });

    it('serves the last known status as stale when the provider call fails', async () => {
      const { get } = redisMock();
      get.mockResolvedValueOnce(null);
      get.mockResolvedValueOnce(cachedValue('accredited', '2026-01-01T00:00:00.000Z'));
      const provider = new FakeProvider();
      provider.failNext = 1;
      const service = new KycService(provider, new KycCircuitBreaker(3, 30_000));

      const result = await service.getStatus('GABC');

      expect(result).toEqual({
        status: KycStatus.ACCREDITED,
        stale: true,
        cachedAt: '2026-01-01T00:00:00.000Z',
      });
    });

    it('throws 503 with an estimated retry when the provider fails with no fallback', async () => {
      const { get } = redisMock();
      get.mockResolvedValueOnce(null);
      get.mockResolvedValueOnce(null);
      const provider = new FakeProvider();
      provider.failNext = 1;
      provider.healthResult = { status: 'down', recoverySeconds: 90 };
      const service = new KycService(provider, new KycCircuitBreaker(3, 30_000));

      const promise = service.getStatus('GABC');

      await expect(promise).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(promise).rejects.toMatchObject({
        response: { retryAfterSeconds: 90 },
      });
    });

    it('falls back to the breaker cooldown when the health endpoint gives no estimate', async () => {
      const { get } = redisMock();
      get.mockResolvedValueOnce(null);
      get.mockResolvedValueOnce(null);
      const provider = new FakeProvider();
      provider.failNext = 1;
      provider.healthResult = null;
      const service = new KycService(provider, new KycCircuitBreaker(3, 30_000));

      await expect(service.getStatus('GABC')).rejects.toMatchObject({
        response: { retryAfterSeconds: expect.any(Number) },
      });
    });

    it('opens the circuit after the failure threshold and stops calling the provider', async () => {
      const { get } = redisMock();
      get.mockResolvedValue(null);
      const provider = new FakeProvider();
      provider.failNext = 100; // keep failing
      const checkSpy = jest.spyOn(provider, 'checkStatus');
      const service = new KycService(provider, new KycCircuitBreaker(2, 60_000));

      // Two failures trip the breaker; the third call must not reach the provider.
      await expect(service.getStatus('GABC')).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(service.getStatus('GABC')).rejects.toBeInstanceOf(ServiceUnavailableException);
      const callsBeforeOpen = checkSpy.mock.calls.length;

      await expect(service.getStatus('GABC')).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(checkSpy.mock.calls.length).toBe(callsBeforeOpen);
    });

    it('serves the last known status as stale while the circuit is open', async () => {
      const { get } = redisMock();
      get.mockResolvedValueOnce(null);
      get.mockResolvedValueOnce(cachedValue('verified', '2026-01-01T00:00:00.000Z'));
      const provider = new FakeProvider();
      const breaker = new KycCircuitBreaker(1, 60_000);
      breaker.recordFailure(); // pre-trip the breaker
      const checkSpy = jest.spyOn(provider, 'checkStatus');
      const service = new KycService(provider, breaker);

      const result = await service.getStatus('GABC');

      expect(result).toEqual({
        status: KycStatus.VERIFIED,
        stale: true,
        cachedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(checkSpy).not.toHaveBeenCalled();
    });

    it('probes the provider again once the circuit becomes half-open', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(0);
      try {
        const { get } = redisMock();
        get.mockResolvedValue(null);
        const provider = new FakeProvider();
        provider.failNext = 1; // first call fails
        const checkSpy = jest.spyOn(provider, 'checkStatus');
        const breaker = new KycCircuitBreaker(1, 10_000);
        const service = new KycService(provider, breaker);

        await expect(service.getStatus('GABC')).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(breaker.currentState).toBe('open');

        // Cooldown elapses -> half-open -> a probe reaches the provider again.
        now.mockReturnValue(11_000);
        const result = await service.getStatus('GABC');

        expect(result.status).toBe(KycStatus.VERIFIED);
        expect(result.stale).toBe(false);
        expect(checkSpy).toHaveBeenCalledTimes(2);
        expect(breaker.currentState).toBe('closed');
      } finally {
        now.mockRestore();
      }
    });

    it('returns PENDING in dev mode when no provider is configured', async () => {
      const { get } = redisMock();
      get.mockResolvedValueOnce(null);
      const provider = {
        isConfigured: () => false,
        checkStatus: jest.fn(),
        health: jest.fn(),
      } as unknown as KycProviderClient;
      const service = new KycService(provider, new KycCircuitBreaker(3, 30_000));

      expect(await service.getStatus('GABC')).toEqual({
        status: KycStatus.PENDING,
        stale: false,
        cachedAt: expect.any(String),
      });
    });
  });

  describe('updateStatus / revoke', () => {
    it('writes the status with a per-state TTL', async () => {
      const { set } = redisMock();
      const service = new KycService(new FakeProvider(), new KycCircuitBreaker(3, 30_000));

      await service.updateStatus('GABC', KycStatus.PENDING);

      const [freshKey, freshValue, freshOpts] = set.mock.calls[0];
      expect(freshKey).toBe('kyc:GABC');
      expect(JSON.parse(freshValue).status).toBe('pending');
      expect(freshOpts).toEqual({ EX: 60 });
    });

    it('revoke deletes both the cached status and the stale fallback', async () => {
      const { del } = redisMock();
      const service = new KycService(new FakeProvider(), new KycCircuitBreaker(3, 30_000));

      await service.revoke('GABC');

      expect(del).toHaveBeenCalledWith('kyc:GABC');
      expect(del).toHaveBeenCalledWith('kyc:GABC:stale');
    });
  });

  describe('isEligible', () => {
    it('compares status order (verified satisfies verified)', async () => {
      const { get } = redisMock();
      get.mockResolvedValueOnce(cachedValue('verified'));
      const service = new KycService(new FakeProvider(), new KycCircuitBreaker(3, 30_000));

      expect(await service.isEligible('GABC', KycStatus.VERIFIED)).toBe(true);
      expect(await service.isEligible('GABC', KycStatus.ACCREDITED)).toBe(false);
    });

    it('pending is not eligible for verified', async () => {
      const { get } = redisMock();
      get.mockResolvedValueOnce(cachedValue('pending'));
      const service = new KycService(new FakeProvider(), new KycCircuitBreaker(3, 30_000));

      expect(await service.isEligible('GABC', KycStatus.VERIFIED)).toBe(false);
    });

    it('rejects a stale status older than the configured threshold', async () => {
      const { get } = redisMock();
      get.mockResolvedValueOnce(null);
      const staleCachedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      get.mockResolvedValueOnce(cachedValue('verified', staleCachedAt));
      const provider = new FakeProvider();
      provider.failNext = 1;
      const service = new KycService(provider, new KycCircuitBreaker(3, 30_000), 24 * 60 * 60);

      await expect(service.isEligible('GABC', KycStatus.VERIFIED)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('allows a stale status within the configured threshold', async () => {
      const { get } = redisMock();
      get.mockResolvedValueOnce(null);
      const staleCachedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      get.mockResolvedValueOnce(cachedValue('verified', staleCachedAt));
      const provider = new FakeProvider();
      provider.failNext = 1;
      const service = new KycService(provider, new KycCircuitBreaker(3, 30_000), 24 * 60 * 60);

      expect(await service.isEligible('GABC', KycStatus.VERIFIED)).toBe(true);
    });
  });

  describe('getCircuitBreakerHealth', () => {
    it('exposes the breaker state, retry window, and stale threshold', () => {
      const service = new KycService(new FakeProvider(), new KycCircuitBreaker(3, 30_000), 3600);

      expect(service.getCircuitBreakerHealth()).toEqual({
        state: 'closed',
        retryAfterSeconds: 0,
        staleThresholdSeconds: 3600,
      });
    });
  });

  describe('KycCircuitBreaker', () => {
    let nowSpy: jest.SpyInstance;

    beforeEach(() => {
      nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
    });

    afterEach(() => {
      nowSpy.mockRestore();
    });

    it('opens after the threshold and refuses requests during cooldown', () => {
      const breaker = new KycCircuitBreaker(2, 10_000);

      expect(breaker.currentState).toBe('closed');
      breaker.recordFailure();
      expect(breaker.currentState).toBe('closed');
      breaker.recordFailure();
      expect(breaker.currentState).toBe('open');
      expect(breaker.isOpen).toBe(true);
      expect(breaker.canAttempt()).toBe(false);
      expect(breaker.retryAfterSeconds).toBe(10);
    });

    it('transitions to halfOpen after cooldown and closes on a successful probe', () => {
      const breaker = new KycCircuitBreaker(1, 10_000);

      breaker.recordFailure();
      expect(breaker.currentState).toBe('open');

      nowSpy.mockReturnValue(11_000);
      expect(breaker.currentState).toBe('halfOpen');
      expect(breaker.isHalfOpen).toBe(true);
      expect(breaker.canAttempt()).toBe(true);

      breaker.recordSuccess();
      expect(breaker.currentState).toBe('closed');
      expect(breaker.retryAfterSeconds).toBe(0);
    });

    it('reopens for a fresh cooldown when a half-open probe fails', () => {
      const breaker = new KycCircuitBreaker(1, 10_000);

      breaker.recordFailure();
      nowSpy.mockReturnValue(11_000);
      expect(breaker.canAttempt()).toBe(true);

      breaker.recordFailure();
      expect(breaker.currentState).toBe('open');
      expect(breaker.retryAfterSeconds).toBe(10);
    });

    it('allows only a single probe while half-open', () => {
      const breaker = new KycCircuitBreaker(1, 10_000);

      breaker.recordFailure();
      nowSpy.mockReturnValue(11_000);

      expect(breaker.canAttempt()).toBe(true);
      expect(breaker.canAttempt()).toBe(false);
    });
  });

  describe('HttpKycProviderClient', () => {
    it('is not configured without a URL or API key', () => {
      const prevUrl = process.env.KYC_PROVIDER_URL;
      const prevKey = process.env.KYC_API_KEY;
      process.env.KYC_PROVIDER_URL = '';
      process.env.KYC_API_KEY = '';
      try {
        expect(new HttpKycProviderClient().isConfigured()).toBe(false);
      } finally {
        process.env.KYC_PROVIDER_URL = prevUrl;
        process.env.KYC_API_KEY = prevKey;
      }
    });
  });
});
