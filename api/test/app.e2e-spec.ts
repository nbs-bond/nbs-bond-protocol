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
 * "Bond subscription — signing (e2e)"
 *   Exercises endpoints that sign and submit Stellar transactions. Requires
 *   ADMIN_SECRET_KEY and INVESTOR_SECRET_KEY to be valid Stellar secret seeds.
 *   Wrapped in `describeWithAdminKey` / `describeWithInvestorKey` so the suite
 *   is automatically skipped (with a human-readable message) when keys are
 *   absent or are the placeholder "S..." values from .env.example.
 *
 * Skip registration timing
 * ------------------------
 * `describe.skip` must be called synchronously at module scope during Jest's
 * test-collection phase. That is why the signing suite uses `describeWith*`
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
 *   2. Replace ADMIN_SECRET_KEY and INVESTOR_SECRET_KEY with real testnet keys
 *   3. Fund both accounts via https://friendbot.stellar.org/?addr=<PUBLIC_KEY>
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
import {
  describeWithAdminKey,
  describeWithInvestorKey,
} from './testenv';

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
      nonce: 0,
      investorAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    };

    it('accepts a valid Stellar address', () => {
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

    it('accepts a payload without a client nonce (server-managed)', () => {
      const missing: Partial<SubscribeDto> = { ...validSubscribe };
      delete missing.nonce;
      return request(app.getHttpServer())
        .post('/bonds/1/subscribe')
        .send(missing)
        .expect(201);
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
// Suite 3: Investor signing flows
//
// Skips automatically when INVESTOR_SECRET_KEY is absent or invalid.
// ---------------------------------------------------------------------------

describeWithInvestorKey('Bond subscription — investor signing (e2e)', () => {
  // Add tests here that call POST /bonds/:id/subscribe, POST /bonds/:id/claim,
  // POST /marketplace/buy, etc.

  it('placeholder — replace with real investor signing tests', () => {
    expect(true).toBe(true);
  });
});
