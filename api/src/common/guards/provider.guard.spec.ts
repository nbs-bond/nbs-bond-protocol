import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ProviderGuard } from './provider.guard';

describe('ProviderGuard', () => {
  let guard: ProviderGuard;

  const createMockContext = (requestData: any): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => requestData,
      }),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    guard = new ProviderGuard();
    delete process.env.ORACLE_PROVIDER_WHITELIST;
  });

  it('throws UnauthorizedException if user is missing', async () => {
    const context = createMockContext({});

    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('Authentication required'),
    );
  });

  it('throws UnauthorizedException if user walletAddress is not in provider whitelist', async () => {
    process.env.ORACLE_PROVIDER_WHITELIST = 'GPROVIDER1,GPROVIDER2';
    const context = createMockContext({ user: { walletAddress: 'GOTHER' } });

    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('Provider access required'),
    );
  });

  it('returns true if user walletAddress is in provider whitelist', async () => {
    process.env.ORACLE_PROVIDER_WHITELIST = 'GPROVIDER1,GPROVIDER2';
    const context = createMockContext({ user: { walletAddress: 'GPROVIDER2' } });

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });
});
