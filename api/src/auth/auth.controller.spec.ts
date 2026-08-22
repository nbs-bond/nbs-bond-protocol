import { Test, TestingModule } from "@nestjs/testing";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthenticatedRequest } from "../common/interfaces/authenticated-request.interface";

describe("AuthController", () => {
  let controller: AuthController;
  let authService: jest.Mocked<AuthService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            generateChallenge: jest.fn(),
            verifySignature: jest.fn(),
            refreshToken: jest.fn(),
            getProfile: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    authService = module.get(AuthService);
  });

  it("should generate challenge", async () => {
    const expected = { challenge: "test-challenge", nonce: "test-nonce" };
    authService.generateChallenge.mockResolvedValue(expected);

    const result = await controller.challenge({ address: "G123" });

    expect(authService.generateChallenge).toHaveBeenCalledWith("G123");
    expect(result).toBe(expected);
  });

  it("should verify signature", async () => {
    const expected = {
      accessToken: "token",
      tokenType: "Bearer",
      expiresIn: "1h",
    };
    const dto = {
      address: "G123",
      originalChallenge: "c",
      signedChallenge: "s",
    };
    authService.verifySignature.mockResolvedValue(expected);

    const result = await controller.verify(dto);

    expect(authService.verifySignature).toHaveBeenCalledWith(dto);
    expect(result).toBe(expected);
  });

  it("should refresh token", async () => {
    const expected = {
      accessToken: "new-token",
      tokenType: "Bearer",
      expiresIn: "1h",
    };
    authService.refreshToken.mockResolvedValue(expected);

    const result = await controller.refresh({ accessToken: "old-token" });

    expect(authService.refreshToken).toHaveBeenCalledWith("old-token");
    expect(result).toBe(expected);
  });

  it("should return profile for authenticated request", async () => {
    const expected = {
      walletAddress: "G123",
      kycStatus: "VERIFIED" as any,
      stale: false,
      cachedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01",
    };
    authService.getProfile.mockResolvedValue(expected);

    const req = {
      user: { walletAddress: "G123", kycStatus: "VERIFIED" },
    } as unknown as AuthenticatedRequest;
    const result = await controller.profile(req);

    expect(authService.getProfile).toHaveBeenCalledWith("G123");
    expect(result).toBe(expected);
  });
});
