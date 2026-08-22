export interface ChallengeResponse {
  challenge: string;
  nonce: string;
}

export interface AuthTokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: string;
}

export interface UserProfileResponse {
  walletAddress: string;
  kycStatus: string;
  stale: boolean;
  cachedAt: string;
  createdAt: string;
}
