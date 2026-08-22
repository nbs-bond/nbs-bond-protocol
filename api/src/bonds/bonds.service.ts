import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  UnauthorizedException,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ContractService } from '../stellar/contract.service';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { KycService } from '../auth/kyc.service';
import { KycStatus } from '../common/interfaces/authenticated-request.interface';
import { toBytes32 } from '../stellar/bytes32';
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
  PeriodInfoResponse,
  PeriodListResponse,
  PeriodReportResponse,
  ReportStatus,
  BondStatusEnum,
  BondMaturityStatusEnum,
  CreditTypeEnum,
} from './interfaces/bond.interface';

const BOND_ISSUER = () => process.env.BOND_ISSUER_ADDRESS || '';
const COUPON_ENGINE = () => process.env.COUPON_ENGINE_ADDRESS || '';
const ORACLE_CONSUMER = () => process.env.ORACLE_CONSUMER_ADDRESS || '';

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
  // Added to replace the previous overloaded use of `Overflow` (= 9) for
  // "not yet mature" / "maturity date in the past", and of
  // `InsufficientSupply` (= 6) for a holder's own balance, on-chain (#114).
  NotYetMature: 14,
  MaturityDateInPast: 15,
  InsufficientBalance: 16,
};

const COUPON_ERROR_CODE = {
  NotInitialized: 1,
  Unauthorized: 2,
  InvalidNonce: 3,
  BondNotFound: 4,
  AccountingMismatch: 13,
};

@Injectable()
export class BondsService implements OnModuleDestroy {
  private readonly logger = new Logger(BondsService.name);
  private redis: RedisClientType;

  constructor(
    private readonly contractService: ContractService,
    private readonly stellarService: StellarService,
    private readonly nonceService: NonceService,
    private readonly kycService: KycService,
  ) {
    this.redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    this.redis.connect().catch(() => {});
  }

  async create(dto: CreateBondDto): Promise<BondResponse> {
    const adminSecret = this.getAdminSecret();
    const adminAddress = this.stellarService.getKeypairFromSecret(adminSecret).publicKey();
    const nonce = await this.nonceService.next(BOND_ISSUER(), adminAddress);

    const configScVal = this.encodeBondConfig(dto);

    let result: xdr.ScVal;
    try {
      ({ result } = await this.contractService.invokeContractMethod(
        BOND_ISSUER(), 'issue_bond', adminSecret,
        [Address.fromString(adminAddress).toScVal(), configScVal],
        nonce,
      ));
    } catch (error) {
      throw this.mapBondError(error);
    }

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

    let ids: number[];
    try {
      const idsScVal = await this.contractService.simulateCall({
        contractAddress: BOND_ISSUER(), method: 'get_bond_ids_range',
        args: [
          nativeToScVal(start, { type: 'u32' }),
          nativeToScVal(limit, { type: 'u32' }),
        ],
      });
      ids = (scValToNative(idsScVal) as bigint[]).map(Number);
    } catch (error) {
      this.logger.warn(`Failed to fetch bond IDs for page ${page}: ${error instanceof Error ? error.message : error}`);
      const stale = await this.redis.get(cacheKey);
      if (stale) return JSON.parse(stale);
      return {
        data: [],
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
      };
    }

    for (const id of ids) {
      try {
        bonds.push(await this.buildBondResponse(id));
      } catch {}
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
    // Gate subscription on KYC: the cached status check makes this resilient
    // to KYC provider outages (see KycService) instead of a synchronous live
    // call on every request.
    const eligible = await this.kycService.isEligible(
      dto.investorAddress,
      KycStatus.VERIFIED,
    );
    if (!eligible) {
      throw new ForbiddenException(
        'KYC verification required before subscribing to a bond',
      );
    }

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
      const balance = await this.getHolderBalance(id, address);
      if (balance > 0) holders.push({ address, balance });
    }

    return { bondId: id, holders, total: holders.length };
  }

  /**
   * Returns the on-chain balance for `address` in bond `id`, or 0 when the
   * address cannot be resolved on-chain. Used to filter the holder set passed
   * to CouponEngine so stale (zero-balance) addresses are never forwarded.
   */
  private async getHolderBalance(id: number, address: string): Promise<number> {
    try {
      const balanceScVal = await this.contractService.simulateCall({
        contractAddress: BOND_ISSUER(), method: 'get_holder_balance',
        args: [nativeToScVal(BigInt(id), { type: 'u64' }), Address.fromString(address).toScVal()],
      });
      return Number(scValToNative(balanceScVal));
    } catch {
      return 0;
    }
  }

  /**
   * Reconciles the off-chain holder set against on-chain state. Candidates are
   * the union of the Redis `bond:<id>:holders` set and the on-chain
   * `HolderList`, so holders who subscribed/transferred without going through
   * the API are included, then filtered to those with a positive balance.
   */
  private async resolveOnChainHolders(id: number): Promise<string[]> {
    const dbHolders = await this.redis.sMembers(`bond:${id}:holders`);
    const onChainHolders = await this.readOnChainHolderList(id);

    const candidates = new Set<string>([...dbHolders, ...onChainHolders]);
    const holders: string[] = [];
    for (const address of candidates) {
      const balance = await this.getHolderBalance(id, address);
      if (balance > 0) holders.push(address);
    }
    return holders;
  }

  /**
   * Reads the on-chain holder list in pages (`get_holder_count` +
   * `get_holder_list_range`) so a bond with many holders does not materialise
   * the full list in a single contract call. Falls back to an empty list if
   * the on-chain list cannot be read, leaving the DB set as the sole source.
   */
  private async readOnChainHolderList(id: number): Promise<string[]> {
    try {
      const countScVal = await this.contractService.simulateCall({
        contractAddress: BOND_ISSUER(), method: 'get_holder_count',
        args: [nativeToScVal(BigInt(id), { type: 'u64' })],
      });
      const count = Number(scValToNative(countScVal));

      const pageSize = 200;
      const holders: string[] = [];
      for (let start = 0; start < count; start += pageSize) {
        const pageScVal = await this.contractService.simulateCall({
          contractAddress: BOND_ISSUER(), method: 'get_holder_list_range',
          args: [
            nativeToScVal(BigInt(id), { type: 'u64' }),
            nativeToScVal(start, { type: 'u32' }),
            nativeToScVal(pageSize, { type: 'u32' }),
          ],
        });
        const page = scValToNative(pageScVal) as string[];
        if (!page || page.length === 0) break;
        holders.push(...page);
      }
      return holders;
    } catch {
      return [];
    }
  }

  async distributeCoupon(id: number, dto: DistributeCouponDto): Promise<CouponDistributionResponse> {
    const adminSecret = this.getAdminSecret();
    const adminAddress = this.stellarService.getKeypairFromSecret(adminSecret).publicKey();

    // Reconcile the off-chain holder set against on-chain state, then fetch
    // each holder's balance so the contract doesn't need to call
    // BondIssuer.get_holder_balance for every address in the transaction.
    const holderAddresses = await this.resolveOnChainHolders(id);
    const holderBalances: Array<{ address: string; balance: bigint }> = [];
    for (const address of holderAddresses) {
      const balance = await this.getHolderBalance(id, address);
      if (balance > 0) {
        holderBalances.push({ address, balance: BigInt(balance) });
      }
    }

    const BATCH_SIZE = dto.batchSize ?? 50;
    let lastResult: any = null;
    let batchCount = 0;

    for (let start = 0; start < holderBalances.length || batchCount === 0; start += BATCH_SIZE) {
      const slice = holderBalances.slice(start, start + BATCH_SIZE);
      const isFinalBatch = start + BATCH_SIZE >= holderBalances.length;
      batchCount += 1;

      const nonce = await this.nonceService.next(COUPON_ENGINE(), adminAddress);

      // Encode Vec<(Address, i128)> as an ScVal vec of 2-element vecs.
      const holdersScVal = xdr.ScVal.scvVec(
        slice.map(({ address, balance }) =>
          xdr.ScVal.scvVec([
            Address.fromString(address).toScVal(),
            nativeToScVal(balance, { type: 'i128' }),
          ]),
        ),
      );

      const { result } = await this.contractService.invokeContractMethod(
        COUPON_ENGINE(), 'distribute_coupon', adminSecret,
        [
          Address.fromString(adminAddress).toScVal(),
          nativeToScVal(BigInt(id), { type: 'u64' }),
          nativeToScVal(dto.periodIndex, { type: 'u32' }),
          holdersScVal,
          nativeToScVal(BigInt(dto.reportId), { type: 'u64' }),
          nativeToScVal(isFinalBatch, { type: 'bool' }),
        ],
        nonce,
      );

      lastResult = result;

      // If there are no holders at all we still need a single final-batch call
      // to finalise the period; break after the first iteration in that case.
      if (holderBalances.length === 0) break;
    }

    const parsed = scValToNative(lastResult) as any[];
    return {
      bondId: id,
      periodIndex: dto.periodIndex,
      totalCredits: Number(parsed?.[2] ?? 0),
      holderCount: Number(parsed?.[3] ?? 0),
      batchCount,
    };
  }

  /**
   * Claims a bondholder's accrued coupon credits on CouponEngine.
   *
   * `sessionAddress` comes from the authenticated JWT (`sub`), which is the
   * only trusted source of the claimant's identity; `dto.investorAddress` is
   * optional and merely cross-checked against it (403 on mismatch) so the
   * frontend can keep sending the wallet address it already has.
   *
   * The claimed amount is whatever CouponEngine.claim_credits returns for
   * this call — the balance it just zeroed — so partial retirements or
   * concurrent accruals are always reflected; no cached figure is used.
   * When nothing is accrued the endpoint short-circuits with `credits: 0`
   * rather than burning a nonce and a transaction fee on a no-op claim.
   */
  async claimCredits(
    id: number,
    dto: ClaimCreditsDto,
    sessionAddress: string,
  ): Promise<ClaimCreditsResponse> {
    const investorAddress = this.resolveCallerAddress(
      sessionAddress,
      dto.investorAddress,
      'investorAddress',
    );
    const investorSecret = this.getSigningSecretFor(
      investorAddress,
      'Claiming',
    );

    const accrued = await this.readAccruedTotal(id, investorAddress);
    if (accrued <= 0) {
      return {
        bondId: id,
        investorAddress,
        credits: 0,
        transactionHash: '',
      };
    }

    const nonce = await this.nonceService.next(COUPON_ENGINE(), investorAddress);

    let result: xdr.ScVal;
    let transactionHash: string | undefined;
    try {
      ({ result, transactionHash } = await this.contractService.invokeContractMethod(
        COUPON_ENGINE(), 'claim_credits', investorSecret,
        [
          Address.fromString(investorAddress).toScVal(),
          nativeToScVal(BigInt(id), { type: 'u64' }),
        ],
        nonce,
      ));
    } catch (error) {
      throw this.mapClaimError(error, id);
    }

    return {
      bondId: id,
      investorAddress,
      credits: Number(scValToNative(result)),
      transactionHash: transactionHash || '',
    };
  }

  /**
   * Current (unclaimed) combined credit balance for `holder` on bond `id`.
   * Read straight from the contract on every call, so it reflects any
   * retirement or accrual that happened since the last response was cached.
   */
  private async readAccruedTotal(id: number, holder: string): Promise<number> {
    const totalScVal = await this.contractService.simulateCall({
      contractAddress: COUPON_ENGINE(), method: 'accrued_credits',
      args: [
        nativeToScVal(BigInt(id), { type: 'u64' }),
        Address.fromString(holder).toScVal(),
      ],
    });
    return Number(scValToNative(totalScVal));
  }

  /**
   * Resolves the address an authenticated request acts for.
   *
   * The session address (JWT `sub`) always wins. A body-supplied address is
   * accepted only when it is identical; a mismatch is an authorisation
   * failure (403), not a malformed request (400), because the request is
   * well-formed — the caller simply is not that address.
   */
  private resolveCallerAddress(
    sessionAddress: string,
    suppliedAddress: string | undefined,
    field: string,
  ): string {
    if (!sessionAddress || !/^G[A-Z2-7]{55}$/.test(sessionAddress)) {
      throw new UnauthorizedException(
        'Authenticated session does not carry a valid Stellar address',
      );
    }
    if (suppliedAddress && suppliedAddress !== sessionAddress) {
      throw new ForbiddenException(
        `${field} does not match the authenticated wallet address`,
      );
    }
    return sessionAddress;
  }

  /**
   * Returns the secret key the API signs investor transactions with, after
   * checking it actually belongs to `address`.
   *
   * The API holds a single investor key (INVESTOR_SECRET_KEY), so it can only
   * sign for that one wallet. Any other authenticated caller gets a 403 rather
   * than a confusing on-chain auth failure. Accepting a pre-signed XDR from
   * the wallet is the intended replacement for this server-side custody.
   */
  private getSigningSecretFor(address: string, action: string): string {
    const secret = process.env.INVESTOR_SECRET_KEY || '';
    if (!secret) {
      throw new InternalServerErrorException(
        'Investor signing key is not configured on this deployment',
      );
    }

    let signerAddress: string;
    try {
      signerAddress = this.stellarService.getKeypairFromSecret(secret).publicKey();
    } catch {
      throw new InternalServerErrorException(
        'Investor signing key is not a valid Stellar secret key',
      );
    }

    if (signerAddress !== address) {
      throw new ForbiddenException(
        `${action} is temporarily limited to the configured investor wallet`,
      );
    }
    return secret;
  }

  private mapClaimError(error: unknown, bondId: number): Error {
    const code = this.extractContractErrorCode(error);

    if (code === COUPON_ERROR_CODE.AccountingMismatch) {
      return new ConflictException(
        `Bond #${bondId} has inconsistent credit accounting on-chain; ` +
        'the claim was rejected rather than settling a mismatched amount.',
      );
    }
    if (code === COUPON_ERROR_CODE.BondNotFound) {
      return new BadRequestException(`Bond #${bondId} does not exist`);
    }
    if (error instanceof Error) {
      return error;
    }
    return new BadRequestException('Failed to claim credits');
  }

  /** Pulls the numeric contract error code out of a ContractService error. */
  private extractContractErrorCode(error: unknown): number | undefined {
    if (!(error instanceof Error)) return undefined;
    const match = error.message.match(/error code (\d+)/);
    return match ? Number(match[1]) : undefined;
  }

  async transfer(id: number, dto: TransferBondDto): Promise<TransferResponse> {
    const investorSecret = process.env.INVESTOR_SECRET_KEY || '';
    const nonce = await this.nonceService.next(BOND_ISSUER(), dto.fromAddress);

    let transactionHash: string | undefined;
    try {
      ({ transactionHash } = await this.contractService.invokeContractMethod(
        BOND_ISSUER(), 'transfer', investorSecret,
        [
          Address.fromString(dto.fromAddress).toScVal(),
          Address.fromString(dto.toAddress).toScVal(),
          nativeToScVal(BigInt(id), { type: 'u64' }),
          nativeToScVal(BigInt(dto.amount), { type: 'i128' }),
        ],
        nonce,
      ));
    } catch (error) {
      throw this.mapBondError(error, id);
    }

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
   * for every credit type. contracts/shared CreditType is a unit enum that
   * encodes as a Symbol, so each variant is passed as its symbol string.
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
    for (const creditType of creditTypeOrder) {
      const typeScVal = await this.contractService.simulateCall({
        contractAddress: COUPON_ENGINE(), method: 'accrued_credits_by_type',
        args: [bondIdScVal, holderScVal, nativeToScVal(creditType, { type: 'symbol' })],
      });
      const amount = Number(scValToNative(typeScVal));
      if (amount > 0) {
        perCreditType.push({ creditType, amount });
      }
    }

    return {
      bondId: id,
      holder,
      total: Number(scValToNative(totalScVal)),
      perCreditType,
    };
  }

  /**
   * Coupon period history for a bond, paginated to keep responses bounded for
   * long-running bonds. Reads the full page in a single `get_period_info_range`
   * cross-contract call (one round-trip per page) instead of N round-trips.
   * Pass `includeReport=true` to hydrate each period's `report_id` into a full
   * OracleConsumer report summary; this is opt-in to avoid the extra
   * cross-contract calls by default.
   */
  async getPeriods(
    id: number,
    page = 1,
    limit = 20,
    includeReport = false,
  ): Promise<PeriodListResponse> {
    const cacheKey = `bond:${id}:periods:${page}:${limit}:${includeReport}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const countScVal = await this.contractService.simulateCall({
      contractAddress: COUPON_ENGINE(),
      method: 'get_period_count',
      args: [nativeToScVal(BigInt(id), { type: 'u64' })],
    });
    const total = Number(scValToNative(countScVal));

    const start = (page - 1) * limit;
    const periodsScVal = await this.contractService.simulateCall({
      contractAddress: COUPON_ENGINE(),
      method: 'get_period_info_range',
      args: [
        nativeToScVal(BigInt(id), { type: 'u64' }),
        nativeToScVal(start, { type: 'u32' }),
        nativeToScVal(limit, { type: 'u32' }),
      ],
    });

    const data: PeriodInfoResponse[] = [];
    for (const raw of (scValToNative(periodsScVal) as any[]) ?? []) {
      const period = this.decodePeriodInfo(raw);
      if (includeReport && period.reportId > 0) {
        period.report = await this.getReportSummary(period.reportId);
      }
      data.push(period);
    }

    const result: PeriodListResponse = {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };

    await this.redis.setEx(cacheKey, 60, JSON.stringify(result));
    return result;
  }

  /**
   * Decodes a CouponEngine `PeriodInfo` struct (field order matches the
   * contract declaration): period_index, start_time, end_time,
   * total_credits_earned, distributed, report_id, undistributed.
   */
  private decodePeriodInfo(data: any[]): PeriodInfoResponse {
    return {
      periodIndex: Number(data[0]),
      startTime: Number(data[1]),
      endTime: Number(data[2]),
      totalCreditsEarned: Number(data[3]),
      distributed: Boolean(data[4]),
      reportId: Number(data[5]),
      undistributed: Number(data[6]),
    };
  }

  private async getReportSummary(reportId: number): Promise<PeriodReportResponse> {
    const reportScVal = await this.contractService.simulateCall({
      contractAddress: ORACLE_CONSUMER(),
      method: 'get_report',
      args: [nativeToScVal(BigInt(reportId), { type: 'u64' })],
    });
    return this.decodeReport(scValToNative(reportScVal) as any[]);
  }

  /**
   * Decodes an OracleConsumer `Report` struct. Field order matches the
   * contract declaration: `id, provider, project_id, project_metadata_hash,
   * period_start, period_end, carbon_sequestered, biodiversity, methodology,
   * ipfs_evidence_hash, status, submitted_at, verified_at`. `project_id`
   * (index 2) is the registry's numeric id and is not surfaced here;
   * `projectId` below is the metadata hash (index 3), kept for
   * compatibility with existing API consumers. `biodiversity` (index 7) is
   * skipped by position when building the summary.
   */
  private decodeReport(data: any[]): PeriodReportResponse {
    return {
      id: Number(data[0]),
      providerAddress: data[1] as string,
      projectId: Buffer.from(data[3] as Uint8Array).toString('hex'),
      periodStart: Number(data[4]),
      periodEnd: Number(data[5]),
      carbonSequestered: Number(data[6]),
      methodology: data[8] as string,
      ipfsHash: Buffer.from(data[9] as Uint8Array).toString('hex'),
      status: this.reportStatusFromIndex(Number(data[10])),
      submittedAt: Number(data[11]),
      verifiedAt: Number(data[12]),
    };
  }

  private reportStatusFromIndex(index: number): ReportStatus {
    return (
      ['Pending', 'Verified', 'Challenged', 'Rejected'][index] as
        | ReportStatus
        | undefined
    ) ?? 'Pending';
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
      toBytes32(dto.projectId),
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

  private mapBondError(error: unknown, bondId?: number): Error {
    if (error instanceof BadRequestException) {
      const message = error.message;
      const match = message.match(/error code (\d+)/);
      const code = match ? Number(match[1]) : undefined;

      if (code === BOND_ERROR_CODE.NotYetMature) {
        return new BadRequestException(
          `Bond #${bondId} cannot be matured before its maturity date. ` +
          'Maturation is only allowed once the maturity date has been reached.',
        );
      }

      if (code === BOND_ERROR_CODE.MaturityDateInPast) {
        return new BadRequestException(
          'Bond maturity date must be in the future.',
        );
      }

      if (code === BOND_ERROR_CODE.InsufficientBalance) {
        return new BadRequestException(
          bondId !== undefined
            ? `Insufficient balance on bond #${bondId} to complete this transfer.`
            : 'Insufficient balance to complete this transfer.',
        );
      }

      return error;
    }
    if (error instanceof Error) {
      return new BadRequestException(error.message);
    }
    return new BadRequestException('Bond operation failed');
  }

  private getAdminSecret(): string {
    return process.env.ADMIN_SECRET_KEY || '';
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.redis.isReady) {
        await this.redis.quit();
        this.logger.log('BondsService: Redis connection closed gracefully');
      } else if (this.redis.isOpen) {
        // The connection never reached the ready state (e.g. Redis was
        // unavailable on startup); quit() would hang waiting for a reply.
        this.redis.disconnect();
      }
    } catch (error) {
      this.logger.warn(
        `BondsService: error closing Redis connection: ${error?.message ?? error}`,
      );
    }
  }
}
