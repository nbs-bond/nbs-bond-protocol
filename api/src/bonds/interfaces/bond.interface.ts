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
  faceValue: number;
  couponSchedule: number[];
  creditType: CreditTypeEnum;
  maturityDate: number;
  maturityStatus: BondMaturityStatusEnum;
  totalSupply: number;
  totalSubscribed: number;
  status: BondStatusEnum;
  createdAt: string;
}

export interface SubscriptionResponse {
  bondId: number;
  investorAddress: string;
  amount: number;
  transactionHash: string;
}

export interface HolderListResponse {
  bondId: number;
  holders: Array<{ address: string; balance: number }>;
  total: number;
}

export interface CouponDistributionResponse {
  bondId: number;
  periodIndex: number;
  totalCredits: number;
  holderCount: number;
}

export interface ClaimCreditsResponse {
  bondId: number;
  investorAddress: string;
  credits: number;
  transactionHash: string;
}

export interface TransferResponse {
  bondId: number;
  fromAddress: string;
  toAddress: string;
  amount: number;
  transactionHash: string;
}

export interface UndistributedTotalResponse {
  bondId: number;
  undistributedTotal: number;
}

export interface AccruedCreditsByType {
  creditType: CreditTypeEnum;
  amount: number;
}

export interface AccruedCreditsResponse {
  bondId: number;
  holder: string;
  total: number;
  perCreditType: AccruedCreditsByType[];
}

export interface SweepUndistributedResponse {
  bondId: number;
  swept: number;
  transactionHash: string;
}
