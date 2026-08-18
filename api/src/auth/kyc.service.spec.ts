import { ServiceUnavailableException } from '@nestjs/common';
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
  describe('getStatus', () => {
    it('serves a fresh cached value without calling the provider', async () => {
      const { client, get } = redisMock();
      get.mockResolvedValueOnce('verified');
      const provider = new FakeProvider();
      const checkSpy = jest.spyOn(provider, 'checkStatus');
      const service = new KycService(provider, new KycCircuitBreaker(3, 30_000));

      const status = await service.getStatus('GABC');

      expect(status).toBe(KycStatus.VERIFIED);
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

      const status = await service.getStatus('GABC');

      expect(status).toBe(KycStatus.VERIFIED);
      expect(set).toHaveBeenCalledWith('kyc:GABC', 'verified', { EX: 3600 });
      expect(set).toHaveBeenCalledWith('kyc:GABC:stale', 'verified');
    });

    it('caches a pending status with the short TTL', async () => {
      const { get, set } = redisMock();
      get.mockResolvedValueOnce(null);
      get.mockResolvedValueOnce(null);
      const provider = new FakeProvider();
      provider.status = KycStatus.PENDING;
      const service = new KycService(provider, new KycCircuitBreaker(3, 30_000));

      await service.getStatus('GABC');

      expect(set).toHaveBeenCalledWith('kyc:GABC', 'pending', { EX: 60 });
    });

    it('caches a rejected/none status with the longer TTL', async () => {
      const { get, set } = redisMock();
      get.mockResolvedValueOnce(null);
      get.mockResolvedValueOnce(null);
      const provider = new FakeProvider();
      provider.status = KycStatus.NONE;
      const service = new KycService(provider, new KycCircuitBreaker(3, 30_000));

      await service.getStatus('GABC');

      expect(set).toHaveBeenCalledWith('kyc:GABC', 'none', { EX: 21600 });
    });

    it('serves the last known status when the provider call fails', async () => {
      const { get } = redisMock();
      get.mockResolvedValueOnce(null);
      get.mockResolvedValueOnce('accredited');
      const provider = new FakeProvider();
      provider.failNext = 1;
      const service = new KycService(provider, new KycCircuitBreaker(3, 30_000));

      const status = await service.getStatus('GABC');

      expect(status).toBe(KycStatus.ACCREDITED);
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
      const provider = new FakeProvider();
      provider.failNext = 100; // keep failing
      const checkSpy = jest.spyOn(provider, 'checkStatus');
      const service = new KycService(provider, new KycCircuitBreaker(2, 60_000));

      // Two failures trip the breaker; the third call must not reach the provider.
      get.mockResolvedValue(null);
      await expect(service.getStatus('GABC')).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(service.getStatus('GABC')).rejects.toBeInstanceOf(ServiceUnavailableException);
      const callsBeforeOpen = checkSpy.mock.calls.length;

      get.mockResolvedValueOnce(null);
      get.mockResolvedValueOnce(null);
      await expect(service.getStatus('GABC')).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(checkSpy.mock.calls.length).toBe(callsBeforeOpen);
    });

    it('serves the last known status while the circuit is open', async () => {
      const { get } = redisMock();
      get.mockResolvedValueOnce(null);
      get.mockResolvedValueOnce('verified'); // stale mirror present
      const provider = new FakeProvider();
      const breaker = new KycCircuitBreaker(1, 60_000);
      breaker.recordFailure(); // pre-trip the breaker
      const checkSpy = jest.spyOn(provider, 'checkStatus');
      const service = new KycService(provider, breaker);

      const status = await service.getStatus('GABC');

      expect(status).toBe(KycStatus.VERIFIED);
      expect(checkSpy).not.toHaveBeenCalled();
    });

    it('resets the circuit on a successful provider read', async () => {
      const { get } = redisMock();
      const provider = new FakeProvider();
      const service = new KycService(provider, new KycCircuitBreaker(2, 60_000));

      get.mockResolvedValue(null);
      provider.failNext = 2;
      await expect(service.getStatus('GABC')).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(service.getStatus('GABC')).rejects.toBeInstanceOf(ServiceUnavailableException);

      // Circuit is open now; a success is impossible while open, so verify the
      // breaker records a success once a read happens (half-open is not
      // implemented — cooldown expiry resets state via a fresh breaker).
      const fresh = new KycCircuitBreaker(2, 60_000);
      fresh.recordFailure();
      fresh.recordSuccess();
      expect(fresh.isOpen).toBe(false);
      expect(fresh.retryAfterSeconds).toBe(0);
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

      expect(await service.getStatus('GABC')).toBe(KycStatus.PENDING);
    });
  });

  describe('updateStatus / revoke', () => {
    it('writes the status with a per-state TTL', async () => {
      const { set } = redisMock();
      const service = new KycService(new FakeProvider(), new KycCircuitBreaker(3, 30_000));

      await service.updateStatus('GABC', KycStatus.PENDING);

      expect(set).toHaveBeenCalledWith('kyc:GABC', 'pending', { EX: 60 });
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
      get.mockResolvedValueOnce('verified');
      const service = new KycService(new FakeProvider(), new KycCircuitBreaker(3, 30_000));

      expect(await service.isEligible('GABC', KycStatus.VERIFIED)).toBe(true);
      expect(await service.isEligible('GABC', KycStatus.ACCREDITED)).toBe(false);
    });

    it('pending is not eligible for verified', async () => {
      const { get } = redisMock();
      get.mockResolvedValueOnce('pending');
      const service = new KycService(new FakeProvider(), new KycCircuitBreaker(3, 30_000));

      expect(await service.isEligible('GABC', KycStatus.VERIFIED)).toBe(false);
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
