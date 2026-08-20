import { ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { KycGuard } from './kyc.guard';
import { KycService } from '../../auth/kyc.service';
import { KycStatus } from '../interfaces/authenticated-request.interface';

describe('KycGuard', () => {
  let guard: KycGuard;
  let kycService: jest.Mocked<KycService>;

  const createMockContext = (requestData: any): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => requestData,
      }),
    } as unknown as ExecutionContext;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycGuard,
        {
          provide: KycService,
          useValue: {
            isEligible: jest.fn(),
          },
        },
      ],
    }).compile();

    guard = module.get<KycGuard>(KycGuard);
    kycService = module.get(KycService);
  });

  it('throws UnauthorizedException if request user is missing', async () => {
    const context = createMockContext({});

    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('Authentication required'),
    );
  });

  it('throws ForbiddenException if KycService.isEligible returns false', async () => {
    kycService.isEligible.mockResolvedValue(false);
    const context = createMockContext({ user: { walletAddress: 'GUSER' } });

    await expect(guard.canActivate(context)).rejects.toThrow(
      new ForbiddenException('KYC verification required'),
    );
    expect(kycService.isEligible).toHaveBeenCalledWith('GUSER', KycStatus.VERIFIED);
  });

  it('returns true if KycService.isEligible returns true', async () => {
    kycService.isEligible.mockResolvedValue(true);
    const context = createMockContext({ user: { walletAddress: 'GUSER' } });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(kycService.isEligible).toHaveBeenCalledWith('GUSER', KycStatus.VERIFIED);
  });
});
