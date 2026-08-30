export enum OrderStatus {
  Open = 'Open',
  PartiallyFilled = 'PartiallyFilled',
  Filled = 'Filled',
  Cancelled = 'Cancelled',
  Expired = 'Expired',
}

export type QuoteAsset = 'USDC' | 'XLM';

export interface OrderResponse {
  id: number;
  seller: string;
  bondId: number;
  amount: string;
  pricePerToken: string;
  quoteAsset: QuoteAsset;
  status: OrderStatus;
  createdAt: string;
}

export interface QuoteBalanceResponse {
  address: string;
  asset: QuoteAsset;
  balance: string;
}

export interface QuoteTransactionResponse {
  address: string;
  asset: QuoteAsset;
  amount: string;
  balance: string;
  transactionHash?: string;
}

export interface PriceFeedResponse {
  bondId: number;
  bestPrice: number;
  averagePrice: number;
  totalOrders: number;
  totalVolume: number;
}

export interface PriceLevel {
  price: number;
  amount: number;
  total: number;
}

export interface SlippageResponse {
  bondId: number;
  amount: number;
  averagePrice: number;
  estimatedTotal: number;
  slippagePercent: number;
}

export interface OnChainPriceQuote {
  price: string;
  total: string;
  slippageBps: string;
}
