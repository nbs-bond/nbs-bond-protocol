import { Injectable, BadRequestException } from '@nestjs/common';
import { ContractService } from '../stellar/contract.service';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { xdr, nativeToScVal, scValToNative, Address } from '@stellar/stellar-sdk';
import { createClient, RedisClientType } from '@redis/client';
import { CreateBondDto } from './dto/create-bond.dto';
import { SubscribeDto } from './dto/subscribe.dto';
import { DistributeCouponDto } from './dto/distribute-coupon.dto';
import { ClaimCreditsDto } from './dto/claim-credits.dto';
import { TransferBondDto } from './dto/transfer-bond.dto';
import {
  BondResponse,
  SubscriptionResponse,
  HolderListResponse,
  CouponDistributionResponse,
  ClaimCreditsResponse,
  TransferResponse,
  UndistributedTotalResponse,
  AccruedCreditsByType,
  AccruedCreditsResponse,
  SweepUndistributedResponse,
  BondStatusEnum,
  BondMaturityStatusEnum,
  CreditTypeEnum,
} from './interfaces/bond.interface';

const BOND_ISSUER = () => process.env.BOND_ISSUER_ADDRESS || '';
const COUPON_ENGINE = () => process.env.COUPON_ENGINE_ADDRESS || '';

const BOND_ERROR_CODE = {
  NotInitialized: 1,
  Unauthorized: 2,
  InvalidNonce: 3,
  BondNotFound: 4,
  BondAlreadyMatured: 5,
  InsufficientSupply: 6,
  ZeroAmount: 7,
  ProjectNotApproved: 8,
  Overflow: 9,
  ReportNotVerified: 10,
};

@Injectable()
export class BondsService {
  private redis: RedisClientType;

  constructor(
    private readonly contractService: ContractService,
    private readonly stellarService: StellarService,
    private readonly nonceService: NonceService,
  ) {
    this.redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    this.redis.connect().catch(() => {});
  }

  async create(dto: CreateBondDto): Promise<BondResponse> {
    const adminSecret = this.getAdminSecret();
    const adminAddress = this.stellarService.getKeypairFromSecret(adminSecret).publicKey();
    const nonce = await this.nonceService.next(BOND_ISSUER(), adminAddress);

    const configScVal = this.encodeBondConfig(dto);

    const { result } = await this.contractService.invokeContractMethod(
      BOND_ISSUER(), 'issue_bond', adminSecret,
      [Address.fromString(adminAddress).toScVal(), configScVal],
      nonce,
    );

    const bondId = Number(scValToNative(result));
    const bond = await this.buildBondResponse(bondId);
    await this.redis.setEx(`bond:${bondId}`, 300, JSON.stringify(bond));
    return bond;
  }

  async findAll(page = 1, limit = 20) {
    const cacheKey = `bonds:${page}:${limit}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const bonds: BondResponse[] = [];
    let total = 0;

    try {
      const countScVal = await this.contractService.simulateCall({
        contractAddress: BOND_ISSUER(), method: 'bond_count', args: [],
      });
      total = Number(scValToNative(countScVal));
    } catch {}

    const start = (page - 1) * limit;
    const end = Math.min(start + limit, total);

    for (let id = 1; id <= total; id++) {
      if (id > start && id <= end) {
        try {
          bonds.push(await this.buildBondResponse(id));
        } catch {}
      }
    }

    const result = {
      data: bonds,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };

    await this.redis.setEx(cacheKey, 60, JSON.stringify(result));
    return result;
  }

  async findOne(id: number): Promise<BondResponse> {
    const cached = await this.redis.get(`bond:${id}`);
    if (cached) return JSON.parse(cached);

    const bond = await this.buildBondResponse(id);
    await this.redis.setEx(`bond:${id}`, 300, JSON.stringify(bond));
    return bond;
  }

  async subscribe(id: number, dto: SubscribeDto): Promise<SubscriptionResponse> {
    const investorSecret = process.env.INVESTOR_SECRET_KEY || '';
    const nonce = await this.nonceService.next(BOND_ISSUER(), dto.investorAddress);
    const { transactionHash } = await this.contractService.invokeContractMethod(
      BOND_ISSUER(), 'subscribe', investorSecret,
      [
        Address.fromString(dto.investorAddress).toScVal(),
        nativeToScVal(BigInt(id), { type: 'u64' }),
        nativeToScVal(BigInt(dto.amount), { type: 'i128' }),
      ],
      nonce,
    );

    await this.redis.del(`bond:${id}`);
    await this.redis.sAdd(`bond:${id}:holders`, dto.investorAddress);

    return { bondId: id, investorAddress: dto.investorAddress, amount: dto.amount, transactionHash: transactionHash || '' };
  }

  async getHolders(id: number): Promise<HolderListResponse> {
    const holderAddresses = await this.redis.sMembers(`bond:${id}:holders`);
    const holders = [];

    for (const address of holderAddresses) {
      try {
        const balanceScVal = await this.contractService.simulateCall({
          contractAddress: BOND_ISSUER(), method: 'get_holder_balance',
          args: [nativeToScVal(BigInt(id), { type: 'u64' }), Address.fromString(address).toScVal()],
        });
        const balance = Number(scValToNative(balanceScVal));
        if (balance > 0) holders.push({ address, balance });
      } catch {}
    }

    return { bondId: id, holders, total: holders.length };
  }

  async distributeCoupon(id: number, dto: DistributeCouponDto): Promise<CouponDistributionResponse> {
    const adminSecret = this.getAdminSecret();
    const adminAddress = this.stellarService.getKeypairFromSecret(adminSecret).publicKey();
    const nonce = await this.nonceService.next(COUPON_ENGINE(), adminAddress);

    const holderAddresses = await this.redis.sMembers(`bond:${id}:holders`);

    const { result } = await this.contractService.invokeContractMethod(
      COUPON_ENGINE(), 'distribute_coupon', adminSecret,
      [
        Address.fromString(adminAddress).toScVal(),
        nativeToScVal(BigInt(id), { type: 'u64' }),
        nativeToScVal(dto.periodIndex, { type: 'u32' }),
        xdr.ScVal.scvVec(holderAddresses.map((h) => Address.fromString(h).toScVal())),
        nativeToScVal(BigInt(dto.reportId), { type: 'u64' }),
      ],
      nonce,
    );

    const parsed = scValToNative(result) as any[];
    return {
      bondId: id,
      periodIndex: dto.periodIndex,
      totalCredits: Number(parsed?.[2] ?? 0),
      holderCount: Number(parsed?.[3] ?? 0),
    };
  }

  async claimCredits(id: number, dto: ClaimCreditsDto): Promise<ClaimCreditsResponse> {
    const investorSecret = process.env.INVESTOR_SECRET_KEY || '';
    const nonce = await this.nonceService.next(COUPON_ENGINE(), dto.investorAddress);

    const { result, transactionHash } = await this.contractService.invokeContractMethod(
      COUPON_ENGINE(), 'claim_credits', investorSecret,
      [
        Address.fromString(dto.investorAddress).toScVal(),
        nativeToScVal(BigInt(id), { type: 'u64' }),
      ],
      nonce,
    );

    return {
      bondId: id,
      investorAddress: dto.investorAddress,
      credits: Number(scValToNative(result)),
      transactionHash: transactionHash || '',
    };
  }

  async transfer(id: number, dto: TransferBondDto): Promise<TransferResponse> {
    const investorSecret = process.env.INVESTOR_SECRET_KEY || '';
    const nonce = await this.nonceService.next(BOND_ISSUER(), dto.fromAddress);

    const { transactionHash } = await this.contractService.invokeContractMethod(
      BOND_ISSUER(), 'transfer', investorSecret,
      [
        Address.fromString(dto.fromAddress).toScVal(),
        Address.fromString(dto.toAddress).toScVal(),
        nativeToScVal(BigInt(id), { type: 'u64' }),
        nativeToScVal(BigInt(dto.amount), { type: 'i128' }),
      ],
      nonce,
    );

    await this.redis.sAdd(`bond:${id}:holders`, dto.toAddress);

    return {
      bondId: id,
      fromAddress: dto.fromAddress,
      toAddress: dto.toAddress,
      amount: dto.amount,
      transactionHash: transactionHash || '',
    };
  }

  async getUndistributedTotal(id: number): Promise<UndistributedTotalResponse> {
    const resultScVal = await this.contractService.simulateCall({
      contractAddress: COUPON_ENGINE(), method: 'get_undistributed_total',
      args: [nativeToScVal(BigInt(id), { type: 'u64' })],
    });

    return {
      bondId: id,
      undistributedTotal: Number(scValToNative(resultScVal)),
    };
  }

  /**
   * Accrued (unclaimed) coupon credits for a holder, per CreditType.
   * Reads CouponEngine.accrued_credits (total) plus accrued_credits_by_type
   * for every credit type; Soroban enums encode as a vec of a single u32
   * variant index, matching contracts/shared CreditType ordering.
   */
  async getAccruedCredits(id: number, holder: string): Promise<AccruedCreditsResponse> {
    if (!/^G[A-Z2-7]{55}$/.test(holder)) {
      throw new BadRequestException('holder must be a valid Stellar public key');
    }

    const holderScVal = Address.fromString(holder).toScVal();
    const bondIdScVal = nativeToScVal(BigInt(id), { type: 'u64' });

    const totalScVal = await this.contractService.simulateCall({
      contractAddress: COUPON_ENGINE(), method: 'accrued_credits',
      args: [bondIdScVal, holderScVal],
    });

    const creditTypeOrder: CreditTypeEnum[] = [
      CreditTypeEnum.Carbon,
      CreditTypeEnum.Biodiversity,
      CreditTypeEnum.Basket,
      CreditTypeEnum.BlueCarbon,
    ];

    const perCreditType: AccruedCreditsByType[] = [];
    for (let variant = 0; variant < creditTypeOrder.length; variant++) {
      const typeScVal = await this.contractService.simulateCall({
        contractAddress: COUPON_ENGINE(), method: 'accrued_credits_by_type',
        args: [bondIdScVal, holderScVal, xdr.ScVal.scvVec([xdr.ScVal.scvU32(variant)])],
      });
      const amount = Number(scValToNative(typeScVal));
      if (amount > 0) {
        perCreditType.push({ creditType: creditTypeOrder[variant], amount });
      }
    }

    return {
      bondId: id,
      holder,
      total: Number(scValToNative(totalScVal)),
      perCreditType,
    };
  }

  async sweepUndistributed(id: number): Promise<SweepUndistributedResponse> {
    const adminSecret = this.getAdminSecret();
    const adminAddress = this.stellarService.getKeypairFromSecret(adminSecret).publicKey();
    const nonce = await this.nonceService.next(COUPON_ENGINE(), adminAddress);

    const { result, transactionHash } = await this.contractService.invokeContractMethod(
      COUPON_ENGINE(), 'sweep_undistributed', adminSecret,
      [
        Address.fromString(adminAddress).toScVal(),
        nativeToScVal(BigInt(id), { type: 'u64' }),
      ],
      nonce,
    );

    return {
      bondId: id,
      swept: Number(scValToNative(result)),
      transactionHash: transactionHash || '',
    };
  }

  async mature(id: number): Promise<BondResponse> {
    const adminSecret = this.getAdminSecret();
    const adminAddress = this.stellarService.getKeypairFromSecret(adminSecret).publicKey();
    const nonce = await this.nonceService.next(BOND_ISSUER(), adminAddress);

    try {
      await this.contractService.invokeContractMethod(
        BOND_ISSUER(), 'mature_bond', adminSecret,
        [Address.fromString(adminAddress).toScVal(), nativeToScVal(BigInt(id), { type: 'u64' })],
        nonce,
      );
    } catch (error) {
      throw this.mapBondError(error, id);
    }

    await this.redis.del(`bond:${id}`);
    return this.buildBondResponse(id);
  }

  private encodeBondConfig(dto: CreateBondDto): xdr.ScVal {
    return xdr.ScVal.scvVec([
      xdr.ScVal.scvBytes(Buffer.from(dto.projectId, 'hex')),
      nativeToScVal(BigInt(dto.faceValue), { type: 'i128' }),
      xdr.ScVal.scvVec(dto.couponSchedule.map((ts) => nativeToScVal(BigInt(ts), { type: 'u64' }))),
      nativeToScVal(dto.creditType, { type: 'symbol' }),
      nativeToScVal(BigInt(dto.maturityDate), { type: 'u64' }),
      nativeToScVal(BigInt(dto.totalSupply), { type: 'i128' }),
    ]);
  }

  private async buildBondResponse(id: number): Promise<BondResponse> {
    const configScVal = await this.contractService.simulateCall({
      contractAddress: BOND_ISSUER(), method: 'get_bond',
      args: [nativeToScVal(BigInt(id), { type: 'u64' })],
    });
    const config = scValToNative(configScVal) as any[];

    const stateScVal = await this.contractService.simulateCall({
      contractAddress: BOND_ISSUER(), method: 'get_bond_state',
      args: [nativeToScVal(BigInt(id), { type: 'u64' })],
    });
    const state = scValToNative(stateScVal) as any[];

    const status = state[1] as BondStatusEnum;
    const maturityDate = Number(config[4]);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const maturityStatus =
      status === BondStatusEnum.Matured || nowSeconds >= maturityDate
        ? BondMaturityStatusEnum.Matured
        : BondMaturityStatusEnum.Active;

    return {
      id,
      projectId: Buffer.from(config[0] as Uint8Array).toString('hex'),
      faceValue: Number(config[1]),
      couponSchedule: (config[2] as any[]).map((v: bigint) => Number(v)),
      creditType: config[3] as CreditTypeEnum,
      maturityDate,
      maturityStatus,
      totalSupply: Number(config[5]),
      totalSubscribed: Number(state[0]),
      status,
      createdAt: new Date(Number(state[2]) * 1000).toISOString(),
    };
  }

  private mapBondError(error: unknown, bondId: number): Error {
    if (error instanceof BadRequestException) {
      const message = error.message;
      const match = message.match(/error code (\d+)/);
      const code = match ? Number(match[1]) : undefined;

      if (code === BOND_ERROR_CODE.Overflow) {
        return new BadRequestException(
          `Bond #${bondId} cannot be matured before its maturity date. ` +
          'Maturation is only allowed once the maturity date has been reached.',
        );
      }

      return error;
    }
    if (error instanceof Error) {
      return new BadRequestException(error.message);
    }
    return new BadRequestException('Failed to mature bond');
  }

  private getAdminSecret(): string {
    return process.env.ADMIN_SECRET_KEY || '';
  }
}
