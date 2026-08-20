import { JwtStrategy } from './jwt.strategy';
import { KycStatus } from '../common/interfaces/authenticated-request.interface';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-chars-long';
    strategy = new JwtStrategy();
  });

  it('validates and maps payload to AuthenticatedUser', async () => {
    const payload = { sub: 'GBKEY123', kycStatus: KycStatus.VERIFIED };
    const user = await strategy.validate(payload);

    expect(user).toEqual({
      walletAddress: 'GBKEY123',
      kycStatus: KycStatus.VERIFIED,
    });
  });
});
