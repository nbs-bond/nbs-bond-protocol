import { Controller, Get } from '@nestjs/common';
import { StellarService } from '../../stellar/stellar.service';
import { KycService } from '../../auth/kyc.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly stellarService: StellarService,
    private readonly kycService: KycService,
  ) {}

  @Get()
  check() {
    return {
      status: 'ok',
      paymentStream: {
        active: this.stellarService.isPaymentStreamActive(),
      },
      kycCircuitBreaker: this.kycService.getCircuitBreakerHealth(),
    };
  }
}
