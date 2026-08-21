import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { KycService } from '../../auth/kyc.service';
import { StellarService } from '../../stellar/stellar.service';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: KycService,
          useValue: {
            getCircuitBreakerHealth: () => ({
              state: 'open',
              retryAfterSeconds: 12,
              staleThresholdSeconds: 86400,
            }),
          },
        },
        {
          provide: StellarService,
          useValue: {
            isPaymentStreamActive: () => true,
          },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('exposes the KYC circuit breaker state', () => {
    expect(controller.check()).toEqual({
      status: 'ok',
      paymentStream: { active: true },
      kycCircuitBreaker: {
        state: 'open',
        retryAfterSeconds: 12,
        staleThresholdSeconds: 86400,
      },
    });
  });
});
