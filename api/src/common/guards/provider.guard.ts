import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticatedUser } from '../interfaces/authenticated-request.interface';

@Injectable()
export class ProviderGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const providers = (process.env.ORACLE_PROVIDER_WHITELIST || '').split(',').filter(Boolean);
    if (!providers.includes(user.walletAddress)) {
      throw new ForbiddenException('Provider access required');
    }

    return true;
  }
}
