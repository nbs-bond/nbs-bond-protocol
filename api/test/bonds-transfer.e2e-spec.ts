/**
 * POST /bonds/:id/transfer (e2e)
 *
 * Exercises the peer-to-peer bond token transfer endpoint end to end through
 * the real BondsController + BondsService stack: JWT authentication, the
 * global validation pipe, address authorisation, the balance pre-flight and
 * the BondIssuer.transfer call itself.
 *
 * The Soroban layer is stubbed at the ContractService boundary so the suite
 * models a holder who has already subscribed to a bond, without needing a
 * funded testnet account; it therefore runs unconditionally in CI. The
 * contract-level transfer semantics are covered by the Rust integration
 * tests under contracts/tests.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { Keypair, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
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

describe('POST /bonds/:id/transfer (e2e)', () => {
  const senderKeypair = Keypair.random();
  const sender = senderKeypair.publicKey();
  const recipient = Keypair.random().publicKey();
  const stranger = Keypair.random().publicKey();
  const BOND_ID = 1;

  /** Tokens the sender holds after the simulated subscription. */
  let senderBalance = 0;

  let app: INestApplication;
  let jwtService: JwtService;

  const simulateCall = jest.fn(({ method }: { method: string }) =>
    method === 'get_holder_balance'
      ? Promise.resolve(nativeToScVal(BigInt(senderBalance), { type: 'i128' }))
      : Promise.resolve(nativeToScVal(BigInt(0), { type: 'i128' })),
  );

  const sendTransaction = jest.fn().mockResolvedValue({
    result: xdr.ScVal.scvVoid(),
    transactionHash: 'e2e-transfer-tx',
    successful: true,
  });

  beforeAll(async () => {
    process.env.INVESTOR_SECRET_KEY = senderKeypair.secret();

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret: process.env.JWT_SECRET }),
      ],
      controllers: [BondsController],
      providers: [
        JwtStrategy,
        BondsService,
        { provide: ContractService, useValue: { simulateCall, sendTransaction } },
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
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
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
    senderBalance = 1_000;
  });

  const tokenFor = (walletAddress: string) => jwtService.sign({ sub: walletAddress });

  it('transfers tokens from the authenticated holder to another address', async () => {
    const response = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/transfer`)
      .set('Authorization', `Bearer ${tokenFor(sender)}`)
      .send({ toAddress: recipient, amount: 250 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      bondId: BOND_ID,
      fromAddress: sender,
      toAddress: recipient,
      amount: 250,
      transactionHash: 'e2e-transfer-tx',
    });

    const call = sendTransaction.mock.calls[0][0];
    expect(call.method).toBe('transfer');
    expect(scValToNative(call.args[0])).toBe(sender);
    expect(scValToNative(call.args[1])).toBe(recipient);
    expect(call.args).toHaveLength(4);
  });

  it('rejects a transfer of somebody else tokens with 403', async () => {
    const response = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/transfer`)
      .set('Authorization', `Bearer ${tokenFor(sender)}`)
      .send({ fromAddress: stranger, toAddress: recipient, amount: 250 });

    expect(response.status).toBe(403);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated transfer with 401', async () => {
    const response = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/transfer`)
      .send({ toAddress: recipient, amount: 250 });

    expect(response.status).toBe(401);
  });

  it('rejects a transfer larger than the holder balance with 400', async () => {
    senderBalance = 10;

    const response = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/transfer`)
      .set('Authorization', `Bearer ${tokenFor(sender)}`)
      .send({ toAddress: recipient, amount: 250 });

    expect(response.status).toBe(400);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects a transfer to the sender own address with 400', async () => {
    const response = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/transfer`)
      .set('Authorization', `Bearer ${tokenFor(sender)}`)
      .send({ toAddress: sender, amount: 250 });

    expect(response.status).toBe(400);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects a malformed toAddress with 400', async () => {
    const response = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/transfer`)
      .set('Authorization', `Bearer ${tokenFor(sender)}`)
      .send({ toAddress: 'not-a-stellar-address', amount: 250 });

    expect(response.status).toBe(400);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects a non-positive amount with 400', async () => {
    const response = await request(app.getHttpServer())
      .post(`/bonds/${BOND_ID}/transfer`)
      .set('Authorization', `Bearer ${tokenFor(sender)}`)
      .send({ toAddress: recipient, amount: 0 });

    expect(response.status).toBe(400);
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
