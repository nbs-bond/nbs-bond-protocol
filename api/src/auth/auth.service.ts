import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { createClient, RedisClientType } from "@redis/client";
import { Keypair } from "@stellar/stellar-sdk";
import * as crypto from "crypto";
import { StellarService } from "../stellar/stellar.service";
import { KycService } from "./kyc.service";
import { VerifySignatureDto } from "./dto/verify-signature.dto";
import {
  ChallengeResponse,
  AuthTokenResponse,
  UserProfileResponse,
} from "./interfaces/auth.interface";

@Injectable()
export class AuthService {
  private redis: RedisClientType;

  constructor(
    private readonly jwtService: JwtService,
    private readonly kycService: KycService,
    private readonly stellarService: StellarService,
  ) {
    this.redis = createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
    });
    this.redis.connect().catch(() => {});
  }

  async generateChallenge(address: string): Promise<ChallengeResponse> {
    if (!this.stellarService.isValidPublicKey(address)) {
      throw new BadRequestException("Invalid Stellar address");
    }

    const nonce = crypto.randomBytes(32).toString("hex");
    const challenge = `NbS Bond Protocol sign-in\nAddress: ${address}\nNonce: ${nonce}\nTimestamp: ${Date.now()}`;

    await this.redis.set(`challenge:${address}`, challenge, { EX: 300 });

    return { challenge, nonce };
  }

  async verifySignature(dto: VerifySignatureDto): Promise<AuthTokenResponse> {
    const storedChallenge = await this.redis.get(`challenge:${dto.address}`);
    if (!storedChallenge || storedChallenge !== dto.originalChallenge) {
      throw new UnauthorizedException("Challenge not found or expired");
    }

    const keypair = Keypair.fromPublicKey(dto.address);
    const isValid = keypair.verify(
      Buffer.from(dto.originalChallenge),
      Buffer.from(dto.signedChallenge, "hex"),
    );

    if (!isValid) {
      throw new UnauthorizedException("Invalid signature");
    }

    await this.redis.del(`challenge:${dto.address}`);

    const payload = { sub: dto.address };
    const accessToken = this.jwtService.sign(payload);

    return { accessToken, tokenType: "Bearer", expiresIn: "1h" };
  }

  async refreshToken(token: string): Promise<AuthTokenResponse> {
    try {
      const payload = this.jwtService.verify(token) as { sub: string };
      const newPayload = { sub: payload.sub };
      const accessToken = this.jwtService.sign(newPayload);
      return { accessToken, tokenType: "Bearer", expiresIn: "1h" };
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
  }

  async getProfile(userId: string): Promise<UserProfileResponse> {
    const kycStatus = await this.kycService.getStatus(userId);
    return {
      walletAddress: userId,
      kycStatus,
      createdAt: new Date().toISOString(),
    };
  }
}
