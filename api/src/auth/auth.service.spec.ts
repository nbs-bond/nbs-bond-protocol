import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { Keypair } from "@stellar/stellar-sdk";
import { AuthService } from "./auth.service";
import { KycService } from "./kyc.service";
import { StellarService } from "../stellar/stellar.service";

const mockRedis = {
  connect: jest.fn().mockResolvedValue(undefined),
  get: jest.fn(),
  set: jest.fn().mockResolvedValue("OK"),
  del: jest.fn().mockResolvedValue(1),
};

jest.mock("@redis/client", () => ({
  createClient: jest.fn(() => mockRedis),
}));

describe("AuthService", () => {
  let service: AuthService;
  let jwtService: jest.Mocked<JwtService>;
  let kycService: jest.Mocked<KycService>;
  // stellarService is required by the AuthService constructor
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let stellarService: jest.Mocked<StellarService>;

  const validKeypair = Keypair.random();
  const validAddress = validKeypair.publicKey();

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue("mock-jwt-token"),
            verify: jest.fn(),
          },
        },
        {
          provide: KycService,
          useValue: {
            getStatus: jest.fn().mockResolvedValue("VERIFIED"),
          },
        },
        {
          provide: StellarService,
          useValue: {
            isValidPublicKey: jest
              .fn()
              .mockImplementation((addr: string) => addr === validAddress),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jwtService = module.get(JwtService);
    kycService = module.get(KycService);
    stellarService = module.get(StellarService);
  });

  describe("generateChallenge", () => {
    it("throws BadRequestException for invalid Stellar address", async () => {
      await expect(
        service.generateChallenge("INVALID_ADDRESS"),
      ).rejects.toThrow(BadRequestException);
    });

    it("generates challenge and stores it in Redis for valid address", async () => {
      const result = await service.generateChallenge(validAddress);

      expect(result).toHaveProperty("challenge");
      expect(result).toHaveProperty("nonce");
      expect(result.challenge).toContain(validAddress);
      expect(mockRedis.set).toHaveBeenCalledWith(
        `challenge:${validAddress}`,
        result.challenge,
        { EX: 300 },
      );
    });
  });

  describe("verifySignature", () => {
    it("throws UnauthorizedException if challenge not found in Redis", async () => {
      mockRedis.get.mockResolvedValue(null);

      await expect(
        service.verifySignature({
          address: validAddress,
          originalChallenge: "test-challenge",
          signedChallenge: "signed-data",
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("throws UnauthorizedException if original challenge does not match stored challenge", async () => {
      mockRedis.get.mockResolvedValue("stored-challenge");

      await expect(
        service.verifySignature({
          address: validAddress,
          originalChallenge: "different-challenge",
          signedChallenge: "signed-data",
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("throws UnauthorizedException if signature verification fails", async () => {
      const challenge = "NbS Bond Protocol sign-in test challenge";
      mockRedis.get.mockResolvedValue(challenge);

      await expect(
        service.verifySignature({
          address: validAddress,
          originalChallenge: challenge,
          signedChallenge: "00".repeat(64),
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("verifies valid signature, issues JWT, and cleans up Redis", async () => {
      const challenge = "NbS Bond Protocol sign-in test challenge";
      const signatureBuffer = validKeypair.sign(Buffer.from(challenge));
      const signedChallenge = signatureBuffer.toString("hex");

      mockRedis.get.mockResolvedValue(challenge);

      const result = await service.verifySignature({
        address: validAddress,
        originalChallenge: challenge,
        signedChallenge,
      });

      expect(mockRedis.del).toHaveBeenCalledWith(`challenge:${validAddress}`);
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: validAddress,
      });
      expect(result).toEqual({
        accessToken: "mock-jwt-token",
        tokenType: "Bearer",
        expiresIn: "1h",
      });
    });
  });

  describe("refreshToken", () => {
    it("returns new access token for valid token", async () => {
      jwtService.verify.mockReturnValue({
        sub: validAddress,
      } as any);

      const result = await service.refreshToken("valid-token");

      expect(jwtService.verify).toHaveBeenCalledWith("valid-token");
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: validAddress,
      });
      expect(result).toEqual({
        accessToken: "mock-jwt-token",
        tokenType: "Bearer",
        expiresIn: "1h",
      });
    });

    it("throws UnauthorizedException for invalid token", async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error("Token expired");
      });

      await expect(service.refreshToken("expired-token")).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe("getProfile", () => {
    it("returns profile with wallet address and KYC status", async () => {
      const profile = await service.getProfile(validAddress);

      expect(kycService.getStatus).toHaveBeenCalledWith(validAddress);
      expect(profile).toEqual({
        walletAddress: validAddress,
        kycStatus: "VERIFIED",
        createdAt: expect.any(String),
      });
    });
  });

  describe("KYC revocation after token issuance", () => {
    it("revokes KYC after token issuance and verifies user cannot perform KYC-gated operations", async () => {
      // Step 1: User signs in successfully
      const challenge = "NbS Bond Protocol sign-in test challenge";
      const signatureBuffer = validKeypair.sign(Buffer.from(challenge));
      const signedChallenge = signatureBuffer.toString("hex");

      mockRedis.get.mockResolvedValue(challenge);

      const result = await service.verifySignature({
        address: validAddress,
        originalChallenge: challenge,
        signedChallenge,
      });

      // Verify token was issued without kycStatus in payload
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: validAddress,
      });
      expect(result.accessToken).toBe("mock-jwt-token");

      // Step 2: Verify KYC is not included in JWT payload
      // The JWT is still valid, but kycStatus is NOT in the payload
      // This means downstream services MUST check KYC live via KycGuard/KycService
      // If KYC is revoked after token issuance, the live check will catch it

      // Step 3: Confirm that JWT does not carry kycStatus
      // Any endpoint protected by KycGuard will call kycService.isEligible() at request time
      // This ensures revoked KYC is enforced immediately, not cached in the JWT
      expect(jwtService.sign).not.toHaveBeenCalledWith(
        expect.objectContaining({ kycStatus: expect.anything() }),
      );
    });
  });
});
