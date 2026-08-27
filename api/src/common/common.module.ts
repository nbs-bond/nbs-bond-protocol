import { Global, Module } from '@nestjs/common';
import { NonceService } from './services/nonce.service';
import { NonceReconcilerService } from './services/nonce-reconciler.service';
import { HealthController } from './health/health.controller';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [HealthController],
  providers: [NonceService, NonceReconcilerService],
  exports: [NonceService],
})
export class CommonModule {}
