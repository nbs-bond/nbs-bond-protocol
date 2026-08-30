/**
 * app.e2e-spec.ts
 *
 * E2E test suite for the NbS Bond API.
 *
 * Suite taxonomy
 * --------------
 * "API validation (e2e)"
 *   Uses an in-process NestJS app with a probe controller. No network calls,
 *   no signing keys required. Always runs.
 *
 * "Bond issuance — admin signing (e2e)" / "Bond subscription — investor
 * pre-signed flow (e2e)"
 *   Exercise endpoints that sign and submit Stellar transactions. Both are
 *   wrapped in `describeWithAdminKey`, since ADMIN_SECRET_KEY is the only
 *   remaining pre-configured signer key an investor flow depends on (to
 *   issue/set up the bond being subscribed to). Investor identity itself is
 *   no longer a pre-configured server-held key — see the #116 note in
 *   ./testenv: a real investor-flow test generates its own throwaway
 *   Keypair, funds it via Friendbot, and signs the XDR returned by the
 *   `/prepare` endpoint locally, exactly as a wallet like Freighter would.
 *
 * Skip registration timing
 * ------------------------
 * `describe.skip` must be called synchronously at module scope during Jest's
 * test-collection phase. That is why the signing suites use `describeWith*`
 * wrappers from ./testenv rather than `test.skip` inside `beforeAll`.
 * Registering a test inside `beforeAll` raises "Cannot add a test after tests
 * have started running" in Jest's circus runner.
 *
 * Adding more suites
 * ------------------
 * • Read-only endpoints (GET /bonds, etc.): use plain `describe` — they should
 *   always run and never depend on signing keys.
 * • Signing endpoints: wrap with the appropriate `describeWith*` helper.
 *
 * To enable signing suites:
 *   1. Copy .env.example to api/.env
 *   2. Replace ADMIN_SECRET_KEY with a real testnet key
 *   3. Fund it via https://friendbot.stellar.org/?addr=<PUBLIC_KEY>
 *   4. Deploy contracts: ./scripts/deploy-testnet.sh
 *   5. Run: cd api && npm run test:e2e
 */

import { Test } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  Controller,
  Post,
  Body,
} from '@nestjs/common';
import * as request from 'supertest';
import { CreateBondDto } from '../src/bonds/dto/create-bond.dto';
import { SubscribeDto } from '../src/bonds/dto/subscribe.dto';
import { CreditTypeEnum } from '../src/bonds/interfaces/bond.interface';
import { describeWithAdminKey } from './testenv';

// ---------------------------------------------------------------------------
// Probe controller — used only by the validation suite
// ---------------------------------------------------------------------------

@Controller()
class ValidationProbeController {
  @Post('bonds')
  createBond(@Body() dto: CreateBondDto) {
    return { ok: true, data: dto };
  }

  @Post('bonds/:id/subscribe')
  subscribe(@Body() dto: SubscribeDto) {
    return { ok: true, data: dto };
  }
}

// ---------------------------------------------------------------------------
// Suite 1: Input validation — no keys required, always runs
// ---------------------------------------------------------------------------

describe('API validation (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ValidationProbeController],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        validationError: { target: false, value: false },
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('create bond', () => {
    const validBond = {
      projectId: 'abcd',
      faceValue: 1000,
      couponSchedule: [1000000, 2000000],
      creditType: CreditTypeEnum.Carbon,
      maturityDate: 3000000,
      totalSupply: 10000,
    };

    it('accepts a valid payload and strips unknown fields', () => {
      return request(app.getHttpServer())
        .post('/bonds')
        .send({ ...validBond, extra: 'should-be-stripped' })
        .expect(201)
        .expect((res) => {
          expect(res.body.data).toEqual(validBond);
        });
    });

    it('rejects a payload without a coupon schedule', () => {
      const missing: Partial<CreateBondDto> = { ...validBond };
      delete missing.couponSchedule;
      return request(app.getHttpServer())
        .post('/bonds')
        .send(missing)
        .expect(400);
    });

    it('rejects an invalid credit type', () => {
      return request(app.getHttpServer())
        .post('/bonds')
        .send({ ...validBond, creditType: 'NotACreditType' })
        .expect(400);
    });

    it('coerces numeric strings into numbers', () => {
      const stringy = Object.fromEntries(
        Object.entries(validBond).map(([k, v]) => [
          k,
          typeof v === 'number' ? String(v) : v,
        ]),
      );
      return request(app.getHttpServer())
        .post('/bonds')
        .send(stringy)
        .expect(201)
        .expect((res) => {
          expect(res.body.data).toEqual(validBond);
        });
    });
  });

  describe('subscribe', () => {
    const validSubscribe = {
      amount: 100,
      investorAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      signedTxXdr: 'AAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };

    it('accepts a valid Stellar address and a signed envelope', () => {
      return request(app.getHttpServer())
        .post('/bonds/1/subscribe')
        .send(validSubscribe)
        .expect(201);
    });

    it('rejects a non-Stellar investor address', () => {
      return request(app.getHttpServer())
        .post('/bonds/1/subscribe')
        .send({ ...validSubscribe, investorAddress: 'not-an-address' })
        .expect(400);
    });

    it('rejects a payload missing the pre-signed transaction envelope', () => {
      const missing: Partial<SubscribeDto> = { ...validSubscribe };
      delete missing.signedTxXdr;
      return request(app.getHttpServer())
        .post('/bonds/1/subscribe')
        .send(missing)
        .expect(400);
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Admin signing flows
//
// Skips automatically when ADMIN_SECRET_KEY is absent or is the placeholder
// "S..." from .env.example. A structured log message explains what is missing
// and where to get a funded testnet key.
//
// describeWithAdminKey calls describe.skip at module scope (collection time),
// which is the correct Jest primitive for skipping a suite when a runtime
// condition is not met. Avoid test.skip inside beforeAll — see file header.
// ---------------------------------------------------------------------------

describeWithAdminKey('Bond issuance — admin signing (e2e)', () => {
  // Add tests here that call POST /bonds, POST /oracle/providers, etc.
  // All tests in this block can safely reference process.env.ADMIN_SECRET_KEY
  // because describeWithAdminKey guarantees it is a valid key before running.

  it('placeholder — replace with real admin signing tests', () => {
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Investor pre-signed-transaction flows (#116)
//
// Gated on describeWithAdminKey (not a dedicated investor key — there is no
// longer a server-held investor key to gate on). A real test in this suite
// generates its own throwaway investor Keypair, funds it via Friendbot,
// calls POST /bonds/:id/subscribe/prepare to get an unsigned XDR, signs it
// locally with the throwaway Keypair (standing in for a wallet like
// Freighter, which is out of scope per #116), and POSTs the signed envelope
// to POST /bonds/:id/subscribe. See test/bonds-claim.e2e-spec.ts for a
// CI-runnable version of this same prepare→sign→submit pattern against a
// mocked ContractService.
// ---------------------------------------------------------------------------

describeWithAdminKey('Bond subscription — investor pre-signed flow (e2e)', () => {
  // Add tests here that drive the full prepare → sign → submit cycle for
  // POST /bonds/:id/subscribe, POST /bonds/:id/claim, POST /bonds/:id/transfer
  // against a live testnet deployment (bond creation via ADMIN_SECRET_KEY,
  // then a throwaway investor Keypair signs its own subscribe/claim/transfer
  // transactions — never a pre-configured investor secret).

  it('placeholder — replace with a real prepare/sign/submit test using a throwaway investor Keypair', () => {
    expect(true).toBe(true);
  });
});
