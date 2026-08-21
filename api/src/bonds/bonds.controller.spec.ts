import { BondsController } from './bonds.controller';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';

describe('BondsController guards', () => {
  const GUARDS_METADATA = '__guards__';

  it.each([
    ['create', [JwtAuthGuard, AdminGuard]],
    ['subscribe', [JwtAuthGuard]],
    ['distributeCoupon', [JwtAuthGuard, AdminGuard]],
    ['claimCredits', [JwtAuthGuard]],
    ['transfer', [JwtAuthGuard]],
    ['mature', [JwtAuthGuard, AdminGuard]],
  ] as const)('guards %s with the required guards', (handler, expected) => {
    const guards: unknown[] = Reflect.getMetadata(
      GUARDS_METADATA,
      BondsController.prototype[handler],
    );
    expect(guards).toEqual(expected);
  });

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

  it('passes the authenticated wallet address to the claim service call', async () => {
    const claimed = {
      bondId: 4,
      investorAddress: 'GINVESTOR',
      credits: 10,
      transactionHash: 'tx',
    };
    const service = { claimCredits: jest.fn().mockResolvedValue(claimed) };
    const controller = new BondsController(service as any);
    const req = { user: { walletAddress: 'GINVESTOR' } } as any;

    await expect(controller.claimCredits(4, {}, req)).resolves.toBe(claimed);
    expect(service.claimCredits).toHaveBeenCalledWith(4, {}, 'GINVESTOR');
  });

  it('routes the claim handler under the /bonds/:id/claim path', () => {
    const path = Reflect.getMetadata('path', BondsController.prototype.claimCredits);
    expect(path).toBe(':id/claim');
  });

  it('routes the periods handler under the /bonds/:id/periods path', () => {
    const path = Reflect.getMetadata('path', BondsController.prototype.getPeriods);
    expect(path).toBe(':id/periods');
  });

  it('exposes GET /:id/periods as a read-only public endpoint', () => {
    const guards: unknown[] | undefined = Reflect.getMetadata(
      GUARDS_METADATA,
      BondsController.prototype.getPeriods,
    );
    expect(guards).toBeUndefined();
  });

  it('delegates GET /:id/periods to the service with pagination + includeReport', async () => {
    const periods = { data: [], meta: { page: 1, limit: 20, total: 0, totalPages: 1 } };
    const service = { getPeriods: jest.fn().mockResolvedValue(periods) };
    const controller = new BondsController(service as any);

    const query = { page: 2, limit: 10, includeReport: true } as any;
    await expect(controller.getPeriods(7, query)).resolves.toBe(periods);
    expect(service.getPeriods).toHaveBeenCalledWith(7, 2, 10, true);
  });
});
