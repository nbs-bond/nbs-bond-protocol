export enum CreditTypeEnum {
  Carbon = 'Carbon',
  Biodiversity = 'Biodiversity',
  Basket = 'Basket',
  BlueCarbon = 'BlueCarbon',
}

export enum BondStatusEnum {
  Active = 'Active',
  Matured = 'Matured',
  Defaulted = 'Defaulted',
}

export enum BondMaturityStatusEnum {
  Active = 'Active',
  Matured = 'Matured',
}

export interface BondResponse {
  id: number;
  projectId: string;
  faceValue: string;
  couponSchedule: string[];
  creditType: CreditTypeEnum;
  maturityDate: number;
  maturityStatus: BondMaturityStatusEnum;
  totalSupply: string;
  totalSubscribed: string;
  status: BondStatusEnum;
  createdAt: string;
}

export interface SubscriptionResponse {
  bondId: number;
  investorAddress: string;
  amount: string;
  transactionHash: string;
}

/**
 * Returned by the `/prepare` step of the pre-signed-transaction flow (see
 * subscribe/claim/transfer). `xdr` is an UNSIGNED base64 transaction envelope
 * the caller's wallet must sign and post back to the corresponding submit
 * endpoint; `nonce` is the contract-level nonce reserved for that submission
 * and is echoed back only for observability/debugging — the caller does not
 * need to resubmit it separately.
 */
export interface PrepareTransactionResponse {
  xdr: string;
  nonce: number;
}

export interface HolderListResponse {
  bondId: number;
  holders: Array<{ address: string; balance: string }>;
  total: number;
}

export interface CouponDistributionResponse {
  bondId: number;
  periodIndex: number;
  totalCredits: string;
  holderCount: number;
  /** Total number of batches submitted for this period. */
  batchCount: number;
}

export interface ClaimCreditsResponse {
  bondId: number;
  investorAddress: string;
  credits: string;
  transactionHash: string;
}

/**
 * Returned by POST /bonds/:id/claim/prepare.
 *
 * `credits` is the accrued total observed at prepare time. When it is 0
 * there is nothing to claim: `xdr`/`nonce` are `null` and no nonce was
 * reserved, so the caller should not proceed to POST /bonds/:id/claim —
 * this mirrors the original single-step endpoint's no-op short-circuit,
 * which avoided burning a nonce and a transaction fee on an empty claim.
 */
export interface ClaimPrepareResponse {
  bondId: number;
  investorAddress: string;
  credits: number;
  xdr: string | null;
  nonce: number | null;
}

export interface TransferResponse {
  bondId: number;
  fromAddress: string;
  toAddress: string;
  amount: string;
  transactionHash: string;
}

export interface UndistributedTotalResponse {
  bondId: number;
  undistributedTotal: string;
}

export interface AccruedCreditsByType {
  creditType: CreditTypeEnum;
  amount: string;
}

export interface AccruedCreditsResponse {
  bondId: number;
  holder: string;
  total: string;
  perCreditType: AccruedCreditsByType[];
}

export interface SweepUndistributedResponse {
  bondId: number;
  /** Wallet that received the swept credits as AccruedCredits. */
  destination: string;
  /** Total credits credited to `destination`. */
  amount: string;
  carbonAmount: string;
  biodiversityAmount: string;
  /**
   * Alias of `amount`, kept so existing clients that read `swept` keep
   * working after SweepReceipt replaced the bare i128 return.
   */
  swept: string;
  transactionHash: string;
}

export type ReportStatus =
  | 'Pending'
  | 'Verified'
  | 'Challenged'
  | 'Rejected';

export interface PeriodReportResponse {
  id: number;
  projectId: string;
  periodStart: number;
  periodEnd: number;
  carbonSequestered: string;
  methodology: string;
  ipfsHash: string;
  providerAddress: string;
  status: ReportStatus;
  submittedAt: number;
  verifiedAt: number;
}

export interface PeriodInfoResponse {
  periodIndex: number;
  startTime: number;
  endTime: number;
  totalCreditsEarned: string;
  distributed: boolean;
  reportId: number;
  undistributed: string;
  report?: PeriodReportResponse;
}

export interface PeriodListResponse {
  data: PeriodInfoResponse[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
