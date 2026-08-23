import { Global, Module } from '@nestjs/common';
import { NonceService } from './services/nonce.service';
import { HealthController } from './health/health.controller';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [HealthController],
  providers: [NonceService],
  exports: [NonceService],
})
export class CommonModule {}
