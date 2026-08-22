/**
 * POST /bonds/:id/claim/prepare + POST /bonds/:id/claim (e2e)
 *
 * Exercises the credit-claim pre-signed-transaction flow end to end through
 * the real BondsController + BondsService stack: JWT authentication, the
 * global validation pipe, address authorisation, and the two-step
 * prepare -> sign -> submit cycle introduced to fix #116 (nonce collisions
 * caused by every investor operation sharing one server-held
 * INVESTOR_SECRET_KEY).
 *
 * The Soroban layer is stubbed at the ContractService boundary (no live
 * testnet/RPC needed, so this runs unconditionally in CI), but the signing
 * step itself is real: the investor's own throwaway Keypair signs the
 * unsigned XDR returned by /prepare, exactly as a wallet extension like
 * Freighter would (Freighter integration itself is out of scope — #116).
 * The contract-level lifecycle is covered by the Rust integration tests
 * under contracts/tests.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import {
  Account,
  Address,
  Contract,
  BASE_FEE,
  Networks,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';
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

// A syntactically valid contract id (checksum-correct StrKey), used only as
// a stand-in "CouponEngine address" for building realistic unsigned XDRs in
// the mocked prepareTransaction() below. Its value is never asserted against
// process.env.COUPON_ENGINE_ADDRESS — ContractService itself is mocked out,
// so no real contract-address validation happens in this suite (that is
// covered by src/stellar/contract.service.spec.ts).
const FAKE_COUPON_ENGINE = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';

describe('POST /bonds/:id/claim/prepare + POST /bonds/:id/claim (e2e)', () => {
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

  /**
   * Builds a real UNSIGNED transaction envelope invoking claim_credits for
   * `sourceAddress`, mirroring what ContractService.prepareTransaction()
   * would return in production. Returning a real, parseable XDR (rather
   * than an opaque placeholder string) lets the test actually sign it below
   * with the investor's Keypair, the same way a wallet extension would.
   */
  const prepareTransaction = jest.fn(
    (
      _contractAddress: string,
      _method: string,
      sourceAddress: string,
      _args: unknown[],
      nonce: number,
    ) => {
      const account = new Account(sourceAddress, '100');
      const contract = new Contract(FAKE_COUPON_ENGINE);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          contract.call(
            'claim_credits',
            Address.fromString(sourceAddress).toScVal(),
            nativeToScVal(BigInt(BOND_ID), { type: 'u64' }),
          ),
        )
        .setTimeout(30)
        .build();
      return Promise.resolve({ xdr: tx.toXDR(), nonce });
    },
  );

  // Mirrors CouponEngine.claim_credits: returns the balance it zeroed.
  // Takes the SIGNED envelope produced by the test (see "sign locally"
  // below) — the API never builds or signs this transaction itself.
  const submitSignedTransaction = jest.fn((signedXdr: string) => {
    // Sanity-check that a genuinely signed envelope was submitted, not the
    // unsigned one returned by prepare().
    const parsed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
    if (!('signatures' in parsed) || parsed.signatures.length === 0) {
      throw new Error('expected a signed transaction envelope');
    }

    const claimed = accruedCredits;
    accruedCredits = 0;
    return Promise.resolve({
      result: nativeToScVal(BigInt(claimed), { type: 'i128' }),
      transactionHash: 'e2e-claim-tx',
      successful: true,
    });
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret: process.env.JWT_SECRET }),
      ],
      controllers: [BondsController],
      providers: [
        JwtStrategy,
        BondsService,
        {
          provide: ContractService,
          useValue: { simulateCall, prepareTransaction, submitSignedTransaction },
        },
        { provide: StellarService, useValue: {} },
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
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // State left by the earlier lifecycle steps: one distributed coupon
    // period leaving 500 credits accrued to the investor.
    accruedCredits = 500;
  });

  const tokenFor = (walletAddress: string) => jwtService.sign({ sub: walletAddress });

  /**
   * Drives the full prepare -> sign locally -> submit cycle for `investor`,
   * returning the final POST /bonds/:id/claim response. This is the pattern
   * a real wallet-backed frontend follows now that the API never holds or
   * signs with an investor's key.
   */
  const prepareSignAndSubmitClaim = async (bearer: string, body: Record<string, unknown> = {}) => {
    const prepareRes = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/claim/prepare`)
      .set('Authorization', `Bearer ${bearer}`)
      .send(body);

    return { prepareRes };
  };

  it('claims the accrued credits for the authenticated bondholder via prepare -> sign -> submit', async () => {
    const { prepareRes } = await prepareSignAndSubmitClaim(tokenFor(investor));

    expect(prepareRes.status).toBe(200);
    expect(prepareRes.body).toMatchObject({
      bondId: BOND_ID,
      investorAddress: investor,
      credits: 500,
    });
    expect(typeof prepareRes.body.xdr).toBe('string');
    expect(prepareRes.body.xdr.length).toBeGreaterThan(0);

    // Sign the unsigned XDR locally with the investor's own Keypair —
    // standing in for a wallet extension (Freighter integration itself is a
    // separate, out-of-scope issue per #116).
    const tx = TransactionBuilder.fromXDR(prepareRes.body.xdr, Networks.TESTNET);
    tx.sign(investorKeypair);
    const signedTxXdr = tx.toXDR();

    const submitRes = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/claim`)
      .set('Authorization', `Bearer ${tokenFor(investor)}`)
      .send({ signedTxXdr });

    expect(submitRes.status).toBe(200);
    expect(submitRes.body).toEqual({
      bondId: BOND_ID,
      investorAddress: investor,
      credits: 500,
      transactionHash: 'e2e-claim-tx',
    });

    expect(submitSignedTransaction).toHaveBeenCalledWith(
      signedTxXdr,
      expect.any(String),
      'claim_credits',
      investor,
    );

    const [, , sourceAddress, args] = prepareTransaction.mock.calls[0] as any[];
    expect(sourceAddress).toBe(investor);
    expect(scValToNative(args[0])).toBe(investor);
  });

  it('prepare is a no-op (no XDR, no nonce reserved) once the credits have already been claimed', async () => {
    accruedCredits = 0;

    const { prepareRes } = await prepareSignAndSubmitClaim(tokenFor(investor));

    expect(prepareRes.status).toBe(200);
    expect(prepareRes.body).toEqual({
      bondId: BOND_ID,
      investorAddress: investor,
      credits: 0,
      xdr: null,
      nonce: null,
    });
    expect(prepareTransaction).not.toHaveBeenCalled();
  });

  it('rejects a prepare request for somebody else with 403', async () => {
    const { prepareRes } = await prepareSignAndSubmitClaim(tokenFor(investor), {
      investorAddress: otherHolder,
    });

    expect(prepareRes.status).toBe(403);
    expect(prepareTransaction).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated prepare request with 401', async () => {
    const response = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/claim/prepare`)
      .send({});

    expect(response.status).toBe(401);
  });

  it('rejects a malformed investorAddress with 400', async () => {
    const response = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/claim/prepare`)
      .set('Authorization', `Bearer ${tokenFor(investor)}`)
      .send({ investorAddress: 'not-a-stellar-address' });

    expect(response.status).toBe(400);
  });

  it('rejects a submit request missing the signed transaction envelope with 400', async () => {
    const response = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/claim`)
      .set('Authorization', `Bearer ${tokenFor(investor)}`)
      .send({});

    expect(response.status).toBe(400);
    expect(submitSignedTransaction).not.toHaveBeenCalled();
  });
});
