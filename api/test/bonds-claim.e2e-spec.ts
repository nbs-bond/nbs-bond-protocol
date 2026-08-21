/**
 * POST /bonds/:id/claim (e2e)
 *
 * Exercises the credit-claim endpoint end to end through the real
 * BondsController + BondsService stack: JWT authentication, the global
 * validation pipe, address authorisation and the CouponEngine call itself.
 *
 * The Soroban layer is stubbed at the ContractService boundary so the suite
 * models a complete lifecycle (bond issued -> subscribed -> coupon
 * distributed -> credits accrued) without needing a funded testnet account,
 * and therefore runs unconditionally in CI. The contract-level lifecycle is
 * covered by the Rust integration tests under contracts/tests.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { Keypair, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import * as request from 'supertest';

jest.mock('@redis/client', () => {
  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    setEx: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(1),
  };
  return { createClient: jest.fn().mockReturnValue(mockClient) };
});

import { JwtStrategy } from '../src/auth/jwt.strategy';
import { KycService } from '../src/auth/kyc.service';
import { BondsController } from '../src/bonds/bonds.controller';
import { BondsService } from '../src/bonds/bonds.service';
import { NonceService } from '../src/common/services/nonce.service';
import { Rfc7807ExceptionFilter } from '../src/common/filters/rfc7807-exception.filter';
import { ContractService } from '../src/stellar/contract.service';
import { StellarService } from '../src/stellar/stellar.service';

describe('POST /bonds/:id/claim (e2e)', () => {
  const investorKeypair = Keypair.random();
  const investor = investorKeypair.publicKey();
  const otherHolder = Keypair.random().publicKey();
  const BOND_ID = 1;

  /** Credits accrued for `investor` after the simulated coupon distribution. */
  let accruedCredits = 0;

  let app: INestApplication;
  let jwtService: JwtService;

  const simulateCall = jest.fn(({ method }: { method: string }) =>
    method === 'accrued_credits'
      ? Promise.resolve(nativeToScVal(BigInt(accruedCredits), { type: 'i128' }))
      : Promise.resolve(nativeToScVal(BigInt(0), { type: 'i128' })),
  );

  // Mirrors CouponEngine.claim_credits: returns the balance it zeroed.
  const invokeContractMethod = jest.fn(() => {
    const claimed = accruedCredits;
    accruedCredits = 0;
    return Promise.resolve({
      result: nativeToScVal(BigInt(claimed), { type: 'i128' }),
      transactionHash: 'e2e-claim-tx',
      successful: true,
    });
  });

  beforeAll(async () => {
    process.env.INVESTOR_SECRET_KEY = investorKeypair.secret();

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret: process.env.JWT_SECRET }),
      ],
      controllers: [BondsController],
      providers: [
        JwtStrategy,
        BondsService,
        { provide: ContractService, useValue: { simulateCall, invokeContractMethod } },
        {
          provide: StellarService,
          useValue: {
            getKeypairFromSecret: (secret: string) => Keypair.fromSecret(secret),
          },
        },
        { provide: NonceService, useValue: { next: jest.fn().mockResolvedValue(0) } },
        { provide: KycService, useValue: { isEligible: jest.fn().mockResolvedValue(true) } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new Rfc7807ExceptionFilter());
    await app.init();
    jwtService = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    delete process.env.INVESTOR_SECRET_KEY;
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // State left by the earlier lifecycle steps: one distributed coupon
    // period leaving 500 credits accrued to the investor.
    accruedCredits = 500;
  });

  const tokenFor = (walletAddress: string) => jwtService.sign({ sub: walletAddress });

  it('claims the accrued credits for the authenticated bondholder', async () => {
    const response = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/claim`)
      .set('Authorization', `Bearer ${tokenFor(investor)}`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      bondId: BOND_ID,
      investorAddress: investor,
      credits: 500,
      transactionHash: 'e2e-claim-tx',
    });

    const [, method, , args] = invokeContractMethod.mock.calls[0] as any[];
    expect(method).toBe('claim_credits');
    expect(scValToNative(args[0])).toBe(investor);
  });

  it('is a no-op once the credits have already been claimed', async () => {
    accruedCredits = 0;

    const response = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/claim`)
      .set('Authorization', `Bearer ${tokenFor(investor)}`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ credits: 0, transactionHash: '' });
    expect(invokeContractMethod).not.toHaveBeenCalled();
  });

  it('rejects a claim for somebody else with 403', async () => {
    const response = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/claim`)
      .set('Authorization', `Bearer ${tokenFor(investor)}`)
      .send({ investorAddress: otherHolder });

    expect(response.status).toBe(403);
    expect(invokeContractMethod).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated claim with 401', async () => {
    const response = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/claim`)
      .send({});

    expect(response.status).toBe(401);
  });

  it('rejects a malformed investorAddress with 400', async () => {
    const response = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/claim`)
      .set('Authorization', `Bearer ${tokenFor(investor)}`)
      .send({ investorAddress: 'not-a-stellar-address' });

    expect(response.status).toBe(400);
  });
});
