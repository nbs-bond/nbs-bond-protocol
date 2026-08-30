/**
 * NonceReconcilerService cron registration (e2e)
 *
 * Guards against the @nestjs/schedule v4 trap where a @Cron without an
 * explicit `name` is registered under a random UUID — which would silently
 * disable the NonceReconcilerService.onModuleDestroy() cleanup and make the
 * job impossible to address by name.
 *
 * Boots the real ScheduleModule.forRoot() (as OracleModule does in the app)
 * with a stubbed NonceService; no Redis or network required.
 */
import { Test } from '@nestjs/testing';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { NonceReconcilerService } from '../src/common/services/nonce-reconciler.service';
import { NonceService } from '../src/common/services/nonce.service';

describe('NonceReconcilerService cron registration (e2e)', () => {
  it('registers reconcileNonces under its stable name at boot', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        {
          provide: NonceService,
          useValue: { listKnownPairs: jest.fn().mockResolvedValue([]) },
        },
        NonceReconcilerService,
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    const registry = moduleRef.get(SchedulerRegistry);
    expect(registry.getCronJobs().has('reconcileNonces')).toBe(true);

    await app.close();
  });
});
