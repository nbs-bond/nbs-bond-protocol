import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { BondsController } from '../src/bonds/bonds.controller';
import { BondsService } from '../src/bonds/bonds.service';
import { Rfc7807ExceptionFilter } from '../src/common/filters/rfc7807-exception.filter';
import { MarketplaceController } from '../src/marketplace/marketplace.controller';
import { DexService } from '../src/marketplace/dex.service';
import { LiquidityService } from '../src/marketplace/liquidity.service';
import { OracleController } from '../src/oracle/oracle.controller';
import { OracleMonitoringService } from '../src/oracle/oracle.monitoring.service';
import { OracleService } from '../src/oracle/oracle.service';
import { ProjectsController } from '../src/projects/projects.controller';
import { ProjectsService } from '../src/projects/projects.service';

describe('API authorization guards (e2e)', () => {
  const adminAddress = 'GADMIN';
  const userAddress = 'GUSER';
  const providerAddress = 'GPROVIDER';
  let app: INestApplication;
  let jwtService: JwtService;

  const bondsService = {
    create: jest.fn(),
    subscribe: jest.fn(),
    distributeCoupon: jest.fn(),
    claimCredits: jest.fn(),
    transfer: jest.fn(),
    mature: jest.fn(),
    sweepUndistributed: jest.fn(),
  };
  const projectsService = {
    approve: jest.fn(),
    reject: jest.fn(),
  };
  const dexService = {
    listBondTokens: jest.fn(),
    buyBondTokens: jest.fn(),
    depositQuote: jest.fn(),
    withdrawQuote: jest.fn(),
    cancelOrder: jest.fn(),
  };
  const oracleService = {
    submitReport: jest.fn(),
    challengeReport: jest.fn(),
    registerProvider: jest.fn(),
  };

  beforeAll(async () => {
    process.env.STELLAR_PUBLIC_KEY = adminAddress;
    process.env.ORACLE_PROVIDER_WHITELIST = providerAddress;

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret: process.env.JWT_SECRET }),
      ],
      controllers: [
        BondsController,
        ProjectsController,
        MarketplaceController,
        OracleController,
      ],
      providers: [
        JwtStrategy,
        { provide: BondsService, useValue: bondsService },
        { provide: ProjectsService, useValue: projectsService },
        { provide: DexService, useValue: dexService },
        { provide: LiquidityService, useValue: {} },
        { provide: OracleService, useValue: oracleService },
        { provide: OracleMonitoringService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new Rfc7807ExceptionFilter());
    await app.init();
    jwtService = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    delete process.env.STELLAR_PUBLIC_KEY;
    delete process.env.ORACLE_PROVIDER_WHITELIST;
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const tokenFor = (walletAddress: string) =>
    jwtService.sign({ sub: walletAddress, kycStatus: 'verified' });

  it.each([
    ['post', '/bonds'],
    ['post', '/bonds/1/subscribe'],
    ['post', '/bonds/1/coupon'],
    ['post', '/bonds/1/claim'],
    ['post', '/bonds/1/transfer'],
    ['post', '/bonds/1/mature'],
    ['post', '/projects/1/approve'],
    ['post', '/projects/1/reject'],
    ['post', '/marketplace/list'],
    ['post', '/marketplace/buy'],
    ['post', '/marketplace/deposit'],
    ['post', '/marketplace/withdraw'],
    ['delete', '/marketplace/orders/1'],
    ['post', '/oracle/reports'],
  ] as const)('returns 401 for unauthenticated %s %s', async (method, path) => {
    const response = await request(app.getHttpServer())[method](path);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      type: 'https://errors.nbs-bond-protocol.org/401',
      status: 401,
      instance: path,
    });
  });

  it('returns 403 when a non-admin approves a project', async () => {
    const response = await request(app.getHttpServer())
      .post('/projects/1/approve')
      .set('Authorization', `Bearer ${tokenFor(userAddress)}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      type: 'https://errors.nbs-bond-protocol.org/403',
      status: 403,
      detail: 'Admin access required',
    });
    expect(projectsService.approve).not.toHaveBeenCalled();
  });

  it('returns 403 when a non-provider submits an oracle report', async () => {
    const response = await request(app.getHttpServer())
      .post('/oracle/reports')
      .set('Authorization', `Bearer ${tokenFor(userAddress)}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      type: 'https://errors.nbs-bond-protocol.org/403',
      status: 403,
      detail: 'Provider access required',
    });
    expect(oracleService.submitReport).not.toHaveBeenCalled();
  });

  it('allows the configured admin to approve a project', async () => {
    const approved = { id: 1, status: 'Approved' };
    projectsService.approve.mockResolvedValue(approved);

    await request(app.getHttpServer())
      .post('/projects/1/approve')
      .set('Authorization', `Bearer ${tokenFor(adminAddress)}`)
      .expect(200, approved);
  });

  it('uses the provider JWT identity when submitting a report', async () => {
    const report = { reportId: 1 };
    oracleService.submitReport.mockResolvedValue(report);

    await request(app.getHttpServer())
      .post('/oracle/reports')
      .set('Authorization', `Bearer ${tokenFor(providerAddress)}`)
      .set('x-provider-address', 'GSPOOFED')
      .send({ projectId: 'project-1' })
      .expect(201, report);

    expect(oracleService.submitReport).toHaveBeenCalledWith(
      { projectId: 'project-1' },
      providerAddress,
    );
  });
});
