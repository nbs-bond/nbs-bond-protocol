import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from '../../auth/auth.service';
import { WalletService } from '../../auth/wallet.service';
import {
  Bond, Project, Order, PaginatedResponse,
  SubscriptionResponse, CreateProjectDto, ListBondDto, BuyBondDto,
  ClaimCreditsResponse, TransferResponse,
  UndistributedTotalResponse, AccruedCreditsResponse, SweepUndistributedResponse,
  QuoteBalanceResponse, QuoteTransactionResponse,
  QuoteAsset, DepositQuoteDto, WithdrawQuoteDto,
  HolderListResponse,
} from '../interfaces/bond.interface';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly walletService = inject(WalletService);

  private headers(): HttpHeaders {
    const token = this.authService.token();
    const walletAddress = this.walletService.address();
    let headers = new HttpHeaders(
      token ? { Authorization: `Bearer ${token}` } : {},
    );
    if (walletAddress) {
      headers = headers.set('x-wallet-address', walletAddress);
    }
    return headers;
  }

  getBonds(page = 1, limit = 20): Observable<PaginatedResponse<Bond>> {
    return this.http.get<PaginatedResponse<Bond>>('/api/bonds', {
      params: { page, limit },
      headers: this.headers(),
    });
  }

  getBond(id: number): Observable<Bond> {
    return this.http.get<Bond>(`/api/bonds/${id}`, { headers: this.headers() });
  }

  issueBond(data: any): Observable<Bond> {
    return this.http.post<Bond>('/api/bonds', data, { headers: this.headers() });
  }

  subscribeToBond(id: number, amount: number): Observable<SubscriptionResponse> {
    const investorAddress = this.walletService.address();
    return this.http.post<SubscriptionResponse>(
      `/api/bonds/${id}/subscribe`,
      { amount, investorAddress },
      { headers: this.headers() },
    );
  }

  claimCredits(id: number): Observable<ClaimCreditsResponse> {
    const investorAddress = this.walletService.address();
    return this.http.post<ClaimCreditsResponse>(
      `/api/bonds/${id}/claim`,
      { investorAddress },
      { headers: this.headers() },
    );
  }

  transferBond(id: number, toAddress: string, amount: number): Observable<TransferResponse> {
    const fromAddress = this.walletService.address();
    return this.http.post<TransferResponse>(
      `/api/bonds/${id}/transfer`,
      { fromAddress, toAddress, amount },
      { headers: this.headers() },
    );
  }

  getHolders(id: number): Observable<HolderListResponse> {
    return this.http.get<HolderListResponse>(
      `/api/bonds/${id}/holders`,
      { headers: this.headers() },
    );
  }

  getUndistributedTotal(id: number): Observable<UndistributedTotalResponse> {
    return this.http.get<UndistributedTotalResponse>(
      `/api/bonds/${id}/undistributed`,
      { headers: this.headers() },
    );
  }

  getAccruedCredits(id: number, holder: string): Observable<AccruedCreditsResponse> {
    return this.http.get<AccruedCreditsResponse>(
      `/api/bonds/${id}/accrued`,
      { params: { holder }, headers: this.headers() },
    );
  }

  sweepUndistributed(id: number): Observable<SweepUndistributedResponse> {
    return this.http.post<SweepUndistributedResponse>(
      `/api/bonds/${id}/sweep-undistributed`,
      {},
      { headers: this.headers() },
    );
  }

  getProjects(page = 1, limit = 20): Observable<PaginatedResponse<Project>> {
    return this.http.get<PaginatedResponse<Project>>('/api/projects', {
      params: { page, limit },
    });
  }

  getProject(id: number): Observable<Project> {
    return this.http.get<Project>(`/api/projects/${id}`);
  }

  registerProject(data: CreateProjectDto): Observable<Project> {
    return this.http.post<Project>('/api/projects', data, { headers: this.headers() });
  }

  getOrders(bondId?: number, page = 1, limit = 20): Observable<PaginatedResponse<Order>> {
    const params: any = { page, limit };
    if (bondId) params.bondId = bondId;
    return this.http.get<PaginatedResponse<Order>>('/api/marketplace/orders', {
      params, headers: this.headers(),
    });
  }

  listBondTokens(data: ListBondDto): Observable<Order> {
    return this.http.post<Order>('/api/marketplace/list', data, { headers: this.headers() });
  }

  buyBondTokens(data: BuyBondDto): Observable<void> {
    return this.http.post<void>('/api/marketplace/buy', data, { headers: this.headers() });
  }

  getQuoteBalance(asset: QuoteAsset = 'USDC'): Observable<QuoteBalanceResponse> {
    return this.http.get<QuoteBalanceResponse>('/api/marketplace/quote-balance', {
      params: { asset },
      headers: this.headers(),
    });
  }

  depositQuote(data: DepositQuoteDto): Observable<QuoteTransactionResponse> {
    return this.http.post<QuoteTransactionResponse>('/api/marketplace/deposit', data, { headers: this.headers() });
  }

  withdrawQuote(data: WithdrawQuoteDto): Observable<QuoteTransactionResponse> {
    return this.http.post<QuoteTransactionResponse>('/api/marketplace/withdraw', data, { headers: this.headers() });
  }
}
