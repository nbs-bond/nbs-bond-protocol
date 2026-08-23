import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

@Injectable()
export class AdminGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const adminKey = process.env.STELLAR_PUBLIC_KEY;
    if (!adminKey) {
      throw new UnauthorizedException('Admin key not configured');
    }
    if (request.user?.walletAddress !== adminKey) {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
