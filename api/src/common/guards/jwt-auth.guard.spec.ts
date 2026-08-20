import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;

  beforeEach(() => {
    guard = new JwtAuthGuard();
  });

  it('returns user if user exists and no error', () => {
    const user = { walletAddress: 'G123', kycStatus: 'VERIFIED' };
    const result = guard.handleRequest(null, user, null);
    expect(result).toBe(user);
  });

  it('throws custom error if error is passed', () => {
    const customError = new Error('Custom error');
    expect(() => guard.handleRequest(customError, null, null)).toThrow(customError);
  });

  it('throws UnauthorizedException if user is not present', () => {
    expect(() => guard.handleRequest(null, null, null)).toThrow(
      new UnauthorizedException('Invalid or expired token'),
    );
  });
});
