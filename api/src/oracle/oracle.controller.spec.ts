import { Test } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  Controller,
  Post,
  Body,
} from '@nestjs/common';
import * as request from 'supertest';
import { OracleController } from './oracle.controller';
import { RegisterProviderDto } from './dto/register-provider.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { ProviderResponse } from './interfaces/oracle.interface';

const VALID_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('OracleController guards', () => {
  const GUARDS_METADATA = '__guards__';

  it('guards POST /providers with JWT + Admin guards', () => {
    const guards: unknown[] = Reflect.getMetadata(
      GUARDS_METADATA,
      OracleController.prototype.registerProvider,
    );
    expect(guards).toEqual([JwtAuthGuard, AdminGuard]);
  });

  it('exposes GET /providers as a read-only public endpoint', () => {
    const guards: unknown[] = Reflect.getMetadata(
      GUARDS_METADATA,
      OracleController.prototype.listProviders,
    );
    expect(guards).toBeUndefined();
  });

  it('routes the register handler under the /providers path', () => {
    const path = Reflect.getMetadata(
      'path',
      OracleController.prototype.registerProvider,
    );
    expect(path).toBe('providers');
  });
});

describe('OracleController.listProviders', () => {
  const provider: ProviderResponse = {
    providerAddress: VALID_ADDRESS,
    methodology: 'VERRA-VCS',
    name: 'Oracle GAAAAA',
    active: true,
    registeredAt: new Date(1700000000000).toISOString(),
  };

  it('combines on-chain providers with health from the monitoring service', async () => {
    const staleness = {
      asOf: new Date().toISOString(),
      projects: [],
      providers: [{ providerAddress: VALID_ADDRESS, isStale: false, projectIds: [] }],
    };
    const oracleService = {
      listProviders: jest.fn().mockResolvedValue([provider]),
      mergeProviderHealth: jest.fn().mockImplementation((p: ProviderResponse[]) => p),
    };
    const monitoringService = { computeStaleness: jest.fn().mockResolvedValue(staleness) };

    const controller = new OracleController(
      oracleService as any,
      monitoringService as any,
    );

    await expect(controller.listProviders()).resolves.toEqual([provider]);
    expect(oracleService.listProviders).toHaveBeenCalledTimes(1);
    expect(monitoringService.computeStaleness).toHaveBeenCalledTimes(1);
    expect(oracleService.mergeProviderHealth).toHaveBeenCalledWith([provider], staleness);
  });

  it('still lists providers when the health monitor is unavailable', async () => {
    const oracleService = {
      listProviders: jest.fn().mockResolvedValue([provider]),
      mergeProviderHealth: jest.fn().mockImplementation((p: ProviderResponse[]) => p),
    };
    const monitoringService = {
      computeStaleness: jest.fn().mockRejectedValue(new Error('monitor down')),
    };

    const controller = new OracleController(
      oracleService as any,
      monitoringService as any,
    );

    await expect(controller.listProviders()).resolves.toEqual([provider]);
    expect(monitoringService.computeStaleness).toHaveBeenCalledTimes(1);
    expect(oracleService.mergeProviderHealth).toHaveBeenCalledWith([provider], undefined);
  });
});

@Controller()
class OracleProviderProbeController {
  @Post('oracle/providers')
  register(@Body() dto: RegisterProviderDto) {
    return { ok: true, data: dto };
  }
}

describe('POST /oracle/providers validation', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OracleProviderProbeController],
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

  it('accepts a valid provider payload', () => {
    return request(app.getHttpServer())
      .post('/oracle/providers')
      .send({ providerAddress: VALID_ADDRESS, methodology: 'VERRA-VCS' })
      .expect(201);
  });

  it('rejects a request without a provider address', () => {
    return request(app.getHttpServer())
      .post('/oracle/providers')
      .send({ methodology: 'VERRA-VCS' })
      .expect(400);
  });

  it('rejects a non-Stellar provider address', () => {
    return request(app.getHttpServer())
      .post('/oracle/providers')
      .send({ providerAddress: 'not-an-address', methodology: 'VERRA-VCS' })
      .expect(400);
  });

  it('rejects a request without a methodology', () => {
    return request(app.getHttpServer())
      .post('/oracle/providers')
      .send({ providerAddress: VALID_ADDRESS })
      .expect(400);
  });

  it('rejects an empty methodology', () => {
    return request(app.getHttpServer())
      .post('/oracle/providers')
      .send({ providerAddress: VALID_ADDRESS, methodology: '' })
      .expect(400);
  });
});
