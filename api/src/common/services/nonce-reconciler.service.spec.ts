/**
 * Unit tests for NonceReconcilerService.
 *
 * The reconciler delegates all Redis access to NonceService (listKnownPairs
 * + sync), so NonceService is mocked here; the real Redis behaviour is
 * covered by nonce.service.spec.ts and the Redis-flush e2e suite.
 */
import { SchedulerRegistry } from '@nestjs/schedule';
import { NonceReconcilerService } from './nonce-reconciler.service';
import { NonceService } from './nonce.service';

describe('NonceReconcilerService', () => {
  let nonceService: {
    listKnownPairs: jest.Mock;
    sync: jest.Mock;
  };
  let reconciler: NonceReconcilerService;

  beforeEach(() => {
    nonceService = {
      listKnownPairs: jest.fn(),
      sync: jest.fn(),
    };
    reconciler = new NonceReconcilerService(
      nonceService as unknown as NonceService,
      {} as SchedulerRegistry,
    );
  });

  it('re-syncs every known pair from on-chain state', async () => {
    nonceService.listKnownPairs.mockResolvedValue([
      { contractAddress: 'CCONTRACTONE', address: 'GADDRESSONE' },
      { contractAddress: 'CCONTRACTTWO', address: 'GADDRESSTWO' },
    ]);
    nonceService.sync.mockResolvedValue(0);

    await reconciler.reconcileNonces();

    expect(nonceService.sync).toHaveBeenCalledTimes(2);
    expect(nonceService.sync).toHaveBeenCalledWith('CCONTRACTONE', 'GADDRESSONE');
    expect(nonceService.sync).toHaveBeenCalledWith('CCONTRACTTWO', 'GADDRESSTWO');
  });

  it('is a no-op when no pairs are known yet', async () => {
    nonceService.listKnownPairs.mockResolvedValue([]);

    await reconciler.reconcileNonces();

    expect(nonceService.sync).not.toHaveBeenCalled();
  });

  it('isolates a failing pair so the remaining pairs still sync', async () => {
    nonceService.listKnownPairs.mockResolvedValue([
      { contractAddress: 'CCONTRACTONE', address: 'GADDRESSONE' },
      { contractAddress: 'CCONTRACTTWO', address: 'GADDRESSTWO' },
    ]);
    nonceService.sync
      .mockRejectedValueOnce(new Error('RPC node unreachable'))
      .mockResolvedValueOnce(0);

    // The cycle completes (allSettled) despite one failure.
    await expect(reconciler.reconcileNonces()).resolves.toBeUndefined();

    expect(nonceService.sync).toHaveBeenCalledTimes(2);
  });

  it('logs and aborts the cycle when the known-pairs registry cannot be read', async () => {
    nonceService.listKnownPairs.mockRejectedValue(new Error('redis down'));

    await expect(reconciler.reconcileNonces()).resolves.toBeUndefined();

    expect(nonceService.sync).not.toHaveBeenCalled();
  });
});
