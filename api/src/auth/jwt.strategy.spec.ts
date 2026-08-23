import { JwtStrategy } from "./jwt.strategy";

describe("JwtStrategy", () => {
  let strategy: JwtStrategy;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret-that-is-at-least-32-chars-long";
    strategy = new JwtStrategy();
  });

  it("validates and maps payload to AuthenticatedUser", async () => {
    const payload = { sub: "GBKEY123" };
    const user = await strategy.validate(payload);

    expect(user).toEqual({
      walletAddress: "GBKEY123",
    });
  });
});
