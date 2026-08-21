import { Controller, Get } from '@nestjs/common';
import { StellarService } from '../../stellar/stellar.service';

@Controller('health')
export class HealthController {
  constructor(private readonly stellarService: StellarService) {}

  @Get()
  check() {
    return {
      status: 'ok',
      paymentStream: {
        active: this.stellarService.isPaymentStreamActive(),
      },
    };
  }
}
