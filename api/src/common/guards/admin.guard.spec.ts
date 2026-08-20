import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AdminGuard } from './admin.guard';

describe('AdminGuard', () => {
  let guard: AdminGuard;

  const createMockContext = (requestData: any): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => requestData,
      }),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    guard = new AdminGuard();
    delete process.env.STELLAR_PUBLIC_KEY;
  });

  it('throws UnauthorizedException if STELLAR_PUBLIC_KEY is not configured', async () => {
    const context = createMockContext({ user: { walletAddress: 'GADMIN' } });

    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('Admin key not configured'),
    );
  });

  it('throws UnauthorizedException if user walletAddress does not match admin key', async () => {
    process.env.STELLAR_PUBLIC_KEY = 'GADMIN_KEY';
    const context = createMockContext({ user: { walletAddress: 'GUSER_KEY' } });

    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('Admin access required'),
    );
  });

  it('returns true if user walletAddress matches STELLAR_PUBLIC_KEY', async () => {
    process.env.STELLAR_PUBLIC_KEY = 'GADMIN_KEY';
    const context = createMockContext({ user: { walletAddress: 'GADMIN_KEY' } });

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });
});
