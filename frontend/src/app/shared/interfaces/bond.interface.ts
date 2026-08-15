export interface Bond {
  id: number;
  projectId: string;
  faceValue: number;
  couponSchedule: number[];
  creditType: 'Carbon' | 'Biodiversity' | 'Basket' | 'BlueCarbon';
  maturityDate: number;
  maturityStatus: 'Active' | 'Matured';
  totalSupply: number;
  totalSubscribed: number;
  status: 'Active' | 'Matured' | 'Defaulted';
  createdAt: string;
}

export interface Project {
  id: number;
  name: string;
  status: 'Pending' | 'Approved' | 'Rejected' | 'Inactive';
  methodology: string;
  country: string;
  metadataIpfsHash: string;
  ownerAddress: string;
  totalAreaHa: number;
  carbonSequestrationEstimate: number;
  createdAt: string;
}

export type QuoteAsset = 'USDC' | 'XLM';

export interface Order {
  id: number;
  seller: string;
  bondId: number;
  amount: number;
  pricePerToken: number;
  quoteAsset: QuoteAsset;
  status: 'Open' | 'PartiallyFilled' | 'Filled' | 'Cancelled' | 'Expired';
  createdAt: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export interface SubscriptionResponse {
  bondId: number;
  subscriber: string;
  amount: number;
  transactionHash: string;
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
  creditType: string;
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

export interface CreateProjectDto {
  name: string;
  methodology: string;
  country: string;
  totalAreaHa: number;
  carbonSequestrationEstimate: number;
  blueCarbon?: boolean;
  biodiversityCorridor?: boolean;
  metadataIpfsHash?: string;
  nonce?: number;
}

export interface ListBondDto {
  bondId: number;
  amount: number;
  pricePerToken: number;
  quoteAsset: 'USDC' | 'XLM';
  nonce?: number;
}

export interface BuyBondDto {
  orderId: number;
  amount: number;
  maxPrice: number;
  nonce?: number;
}

export interface QuoteBalanceResponse {
  address: string;
  asset: QuoteAsset;
  balance: number;
}

export interface QuoteTransactionResponse {
  address: string;
  asset: QuoteAsset;
  amount: number;
  transactionHash?: string;
}

export interface DepositQuoteDto {
  asset: QuoteAsset;
  amount: number;
  nonce?: number;
}

export interface WithdrawQuoteDto {
  asset: QuoteAsset;
  amount: number;
  nonce?: number;
}
