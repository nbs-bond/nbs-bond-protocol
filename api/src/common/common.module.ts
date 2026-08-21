import { Global, Module } from '@nestjs/common';
import { NonceService } from './services/nonce.service';
import { HealthController } from './health/health.controller';

@Global()
@Module({
  controllers: [HealthController],
  providers: [NonceService],
  exports: [NonceService],
})
export class CommonModule {}
