import { BondsController } from './bonds.controller';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';

describe('BondsController guards', () => {
  const GUARDS_METADATA = '__guards__';

  it('guards POST /:id/sweep-undistributed with JWT + Admin guards', () => {
    const guards: unknown[] = Reflect.getMetadata(
      GUARDS_METADATA,
      BondsController.prototype.sweepUndistributed,
    );
    expect(guards).toEqual([JwtAuthGuard, AdminGuard]);
  });

  it('exposes GET /:id/undistributed as a read-only public endpoint', () => {
    const guards: unknown[] = Reflect.getMetadata(
      GUARDS_METADATA,
      BondsController.prototype.getUndistributedTotal,
    );
    expect(guards).toBeUndefined();
  });

  it('routes the sweep handler under the /bonds/:id/sweep-undistributed path', () => {
    const path = Reflect.getMetadata('path', BondsController.prototype.sweepUndistributed);
    expect(path).toBe(':id/sweep-undistributed');
  });

  it('exposes GET /:id/accrued as a read-only public endpoint', () => {
    const guards: unknown[] | undefined = Reflect.getMetadata(
      GUARDS_METADATA,
      BondsController.prototype.getAccruedCredits,
    );
    expect(guards).toBeUndefined();
  });

  it('routes the accrued handler under the /bonds/:id/accrued path', () => {
    const path = Reflect.getMetadata('path', BondsController.prototype.getAccruedCredits);
    expect(path).toBe(':id/accrued');
  });

  it('delegates GET /:id/accrued to the service with the holder query param', async () => {
    const accrued = { bondId: 1, holder: 'holder-key', total: 0, perCreditType: [] };
    const service = { getAccruedCredits: jest.fn().mockResolvedValue(accrued) };
    const controller = new BondsController(service as any);

    await expect(controller.getAccruedCredits(1, 'holder-key')).resolves.toBe(accrued);
    expect(service.getAccruedCredits).toHaveBeenCalledWith(1, 'holder-key');
  });
});
