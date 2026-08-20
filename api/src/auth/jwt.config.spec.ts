import { getJwtSecret } from './jwt.config';

describe('getJwtSecret', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalJwtSecret = process.env.JWT_SECRET;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  it('returns the configured secret', () => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.NODE_ENV = 'test';

    expect(getJwtSecret()).toBe('test-secret');
  });

  it('fails outside development when the secret is missing', () => {
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'production';

    expect(() => getJwtSecret()).toThrow('JWT_SECRET must be set');
  });

  it('generates a stable ephemeral secret in development', () => {
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'development';

    const first = getJwtSecret();
    const second = getJwtSecret();

    expect(first).toHaveLength(64);
    expect(second).toBe(first);
  });
});
