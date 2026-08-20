import { randomBytes } from 'crypto';

let developmentSecret: string | undefined;
let developmentWarningLogged = false;

export function getJwtSecret(): string {
  const configuredSecret = process.env.JWT_SECRET?.trim();
  if (configuredSecret) {
    return configuredSecret;
  }

  if (process.env.NODE_ENV === 'development') {
    developmentSecret ??= randomBytes(32).toString('hex');
    if (!developmentWarningLogged) {
      console.warn('JWT_SECRET is not set; using an ephemeral development secret.');
      developmentWarningLogged = true;
    }
    return developmentSecret;
  }

  throw new Error('JWT_SECRET must be set when NODE_ENV is not development.');
}
