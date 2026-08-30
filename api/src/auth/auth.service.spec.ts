import { BadRequestException, ConflictException, UnauthorizedException } from "@nestjs/common";
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
  getDel: jest.fn(),
};

jest.mock("@redis/client", () => ({
  createClient: jest.fn(() => mockRedis),
}));

describe("AuthService", () => {
  let service: AuthService;
  let jwtService: jest.Mocked<JwtService>;
  let kycService: jest.Mocked<KycService>;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let stellarService: jest.Mocked<StellarService>;

  const validKeypair = Keypair.random();
  const validAddress = validKeypair.publicKey();

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.del.mockResolvedValue(1);

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
            getStatus: jest.fn().mockResolvedValue({
              status: "VERIFIED",
              stale: false,
              cachedAt: "2026-01-01T00:00:00.000Z",
            }),
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

    it("generates challenge and stores it in Redis with NX for valid address", async () => {
      const result = await service.generateChallenge(validAddress);

      expect(result).toHaveProperty("challenge");
      expect(result).toHaveProperty("nonce");
      expect(result.challenge).toContain(validAddress);
      expect(mockRedis.set).toHaveBeenCalledWith(
        `challenge:${validAddress}`,
        result.challenge,
        { EX: 300, NX: true },
      );
    });

    it("throws ConflictException when a challenge is already pending", async () => {
      mockRedis.set.mockResolvedValue(null); // NX fails: key already exists

      await expect(
        service.generateChallenge(validAddress),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("verifySignature", () => {
    it("throws UnauthorizedException if challenge not found in Redis", async () => {
      mockRedis.getDel.mockResolvedValue(null);

      await expect(
        service.verifySignature({
          address: validAddress,
          originalChallenge: "test-challenge",
          signedChallenge: "signed-data",
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("throws UnauthorizedException if original challenge does not match stored challenge", async () => {
      mockRedis.getDel.mockResolvedValue("stored-challenge");

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
      mockRedis.getDel.mockResolvedValue(challenge);

      await expect(
        service.verifySignature({
          address: validAddress,
          originalChallenge: challenge,
          signedChallenge: "00".repeat(64),
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("verifies valid signature, issues JWT, and atomically consumes the challenge via GETDEL", async () => {
      const challenge = "NbS Bond Protocol sign-in test challenge";
      const signatureBuffer = validKeypair.sign(Buffer.from(challenge));
      const signedChallenge = signatureBuffer.toString("hex");

      mockRedis.getDel.mockResolvedValue(challenge);

      const result = await service.verifySignature({
        address: validAddress,
        originalChallenge: challenge,
        signedChallenge,
      });

      expect(mockRedis.getDel).toHaveBeenCalledWith(`challenge:${validAddress}`);
      expect(mockRedis.del).not.toHaveBeenCalled(); // no separate del anymore
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: validAddress,
      });
      expect(result).toEqual({
        accessToken: "mock-jwt-token",
        tokenType: "Bearer",
        expiresIn: "1h",
      });
    });

    describe("race condition: concurrent verification with the same challenge", () => {
      it("only allows one of two concurrent requests to succeed", async () => {
        const challenge = "NbS Bond Protocol sign-in test challenge";
        const signatureBuffer = validKeypair.sign(Buffer.from(challenge));
        const signedChallenge = signatureBuffer.toString("hex");

        // Simulate Redis's real atomicity: the first GETDEL call to resolve
        // gets the value, every subsequent call gets null because the key
        // is already gone. This mirrors what GETDEL guarantees server-side
        // even under real concurrent access.
        let consumed = false;
        mockRedis.getDel.mockImplementation(async () => {
          if (consumed) return null;
          consumed = true;
          return challenge;
        });

        const dto = {
          address: validAddress,
          originalChallenge: challenge,
          signedChallenge,
        };

        const [first, second] = await Promise.allSettled([
          service.verifySignature(dto),
          service.verifySignature(dto),
        ]);

        const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
        const rejected = [first, second].filter((r) => r.status === "rejected");

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
          UnauthorizedException,
        );
        expect(mockRedis.getDel).toHaveBeenCalledTimes(2);
      });

      it("rejects a second verification attempt after the first already succeeded", async () => {
        const challenge = "NbS Bond Protocol sign-in test challenge";
        const signatureBuffer = validKeypair.sign(Buffer.from(challenge));
        const signedChallenge = signatureBuffer.toString("hex");

        mockRedis.getDel.mockResolvedValueOnce(challenge).mockResolvedValueOnce(null);

        const dto = {
          address: validAddress,
          originalChallenge: challenge,
          signedChallenge,
        };

        await expect(service.verifySignature(dto)).resolves.toMatchObject({
          accessToken: "mock-jwt-token",
        });

        await expect(service.verifySignature(dto)).rejects.toThrow(
          UnauthorizedException,
        );
      });
    });
  });

  // ...refreshToken, getProfile, KYC revocation describe blocks unchanged
});