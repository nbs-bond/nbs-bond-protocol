import { Component, inject, OnInit, ChangeDetectionStrategy, signal, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { interval, map, startWith } from 'rxjs';
import { ApiService } from '../../shared/services/api.service';
import { AuthService } from '../../auth/auth.service';
import { WalletService } from '../../auth/wallet.service';
import { StatusBadgeComponent } from '../../shared/components/status-badge/status-badge.component';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner.component';
import { QuoteBalanceComponent, QuoteBalances } from '../../shared/components/quote-balance/quote-balance.component';
import { Order, Bond, QuoteAsset } from '../../shared/interfaces/bond.interface';

/**
 * Seconds remaining at which an order's countdown switches to the
 * "expiring soon" amber highlight. Kept here, not as a magic number in
 * the template, so it can be tuned without hunting through markup.
 */
const EXPIRY_WARNING_THRESHOLD_S = 60;

@Component({
  selector: 'app-marketplace-list',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, StatusBadgeComponent, LoadingSpinnerComponent, QuoteBalanceComponent],
  template: `
    <div class="marketplace-page">
      <div class="page-header">
        <h1 class="page-title">Marketplace</h1>
        <a class="btn btn-primary" [routerLink]="['/marketplace/sell']" [queryParams]="{ bondId: filterBondId() }">
          List Tokens for Sale
        </a>
      </div>

      @if (error()) {
        <div class="error-banner">{{ error() }}</div>
      }

      @if (walletService.isConnected()) {
        <div class="quote-section">
          <app-quote-balance #quotePanel (balanceChange)="onBalancesChange($event)" />
        </div>
      }

      <div class="filters">
        <label class="filter-label">
          Bond Filter
          <select class="filter-select" [ngModel]="filterBondId()" (ngModelChange)="onFilterChange($event)">
            <option [ngValue]="null">All Bonds</option>
            @for (bond of bonds(); track bond.id) {
              <option [ngValue]="bond.id">Bond #{{ bond.id }}</option>
            }
          </select>
        </label>
      </div>

      @if (loading()) {
        <div class="loading-section"><app-loading-spinner size="lg" /></div>
      } @else {
        @if (priceKeys().length > 0) {
          <div class="price-overview">
            <h3 class="section-title">Price Overview</h3>
            <div class="price-grid">
              @for (bondId of priceKeys(); track bondId) {
                <div class="price-card">
                  <span class="price-bond">Bond #{{ bondId }}</span>
                  <span class="price-best">Best: {{ bestPrices()[bondId].best }}</span>
                  <span class="price-avg">Avg: {{ bestPrices()[bondId].average | number:'1.1-1' }} USDC</span>
                </div>
              }
            </div>
          </div>
        }

        <div class="orders-section">
          <div class="section-header">
            <h3 class="section-title">Open Orders ({{ orders().length }})</h3>
          </div>

          @if (orders().length === 0) {
            <div class="empty-section">
              <p>No active orders. List your bond tokens for sale.</p>
            </div>
          } @else {
            <div class="orders-table-wrapper">
              <table class="orders-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Bond</th>
                    <th>Seller</th>
                    <th>Amount</th>
                    <th>Price</th>
                    <th>Asset</th>
                    <th>Status</th>
                    <th>Expires</th>
                    <th>Created</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  @for (order of filteredOrders(); track order.id) {
                    <tr>
                      <td>{{ order.id }}</td>
                      <td>{{ order.bondId }}</td>
                      <td class="mono">{{ order.seller.slice(0, 8) }}...</td>
                      <td>{{ order.amount }}</td>
                      <td>{{ order.pricePerToken }}</td>
                      <td>{{ order.quoteAsset }}</td>
                      <td><app-status-badge [status]="order.status" variant="bond" /></td>
                      <td [class.expiry-soon]="isExpiringSoon(order)" [class.expiry-expired]="isExpired(order)">
                        {{ formatCountdown(secondsRemaining(order)) }}
                      </td>
                      <td>{{ order.createdAt | date }}</td>
                      <td>
                          @if (order.status === 'Open' || order.status === 'PartiallyFilled') {
                            @if (isExpired(order)) {
                              <span class="expiry-expired-label">Expired</span>
                            } @else if (buyOrderId() === order.id) {
                              <div class="buy-form">
                                <input type="number" class="buy-input" placeholder="Amount" [(ngModel)]="buyAmount" min="1" />
                                <input type="number" class="buy-input" placeholder="Max price" [(ngModel)]="buyMaxPrice" min="0.01" />
                                @if (buyRequirement(order); as req) {
                                  <div class="buy-requirement">
                                    @if (req.sufficient) {
                                      <span class="sufficient-msg">
                                        Escrow sufficient: {{ req.required }} {{ order.quoteAsset }} needed, {{ req.available }} available.
                                      </span>
                                    } @else {
                                      <span class="insufficient-msg">
                                        Insufficient escrow: need {{ req.required }} {{ order.quoteAsset }}, have {{ req.available }}.
                                      </span>
                                      <button class="btn btn-sm btn-outline" (click)="focusQuotePanel()">
                                        Deposit {{ req.shortfall }} {{ order.quoteAsset }} to buy
                                      </button>
                                    }
                                  </div>
                                }
                                <div class="buy-actions">
                                  <button class="btn btn-sm btn-primary" (click)="onBuy(order)" [disabled]="buySubmitting() || !canConfirm(order) || isExpired(order)">Confirm</button>
                                  <button class="btn btn-sm btn-outline" (click)="cancelBuy()">Cancel</button>
                                </div>
                                @if (buyError()) {
                                  <div class="error-msg">{{ buyError() }}</div>
                                }
                              </div>
                            } @else {
                              <button class="btn btn-sm btn-primary" (click)="openBuy(order)">Buy</button>
                            }
                          }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </div>

        @if (walletService.isConnected() && myOrders().length > 0) {
          <div class="orders-section my-orders">
            <h3 class="section-title">My Orders</h3>
            <div class="orders-table-wrapper">
              <table class="orders-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Bond</th>
                    <th>Amount</th>
                    <th>Price</th>
                    <th>Status</th>
                    <th>Expires</th>
                    <th>Created</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  @for (order of myOrders(); track order.id) {
                    <tr>
                      <td>{{ order.id }}</td>
                      <td>{{ order.bondId }}</td>
                      <td>{{ order.amount }}</td>
                      <td>{{ order.pricePerToken }}</td>
                      <td><app-status-badge [status]="order.status" variant="bond" /></td>
                      <td [class.expiry-soon]="isExpiringSoon(order)" [class.expiry-expired]="isExpired(order)">
                        {{ formatCountdown(secondsRemaining(order)) }}
                      </td>
                      <td>{{ order.createdAt | date }}</td>
                      <td>&mdash;</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .marketplace-page { max-width: 1200px; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .page-title { font-size: 1.5rem; font-weight: 700; }
    .error-banner { background: #fef2f2; color: #ef4444; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.875rem; }
    .quote-section { margin-bottom: 24px; }
    .filters { margin-bottom: 20px; }
    .filter-label { font-size: 0.8125rem; font-weight: 600; color: #1a1a2e; display: flex; align-items: center; gap: 8px; }
    .filter-select { padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.875rem; outline: none; background: #fff; }
    .filter-select:focus { border-color: #3b82f6; }
    .section-title { font-size: 1rem; font-weight: 600; margin-bottom: 12px; }
    .price-overview { margin-bottom: 24px; }
    .price-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
    .price-card { background: #fff; border-radius: 10px; padding: 16px; box-shadow: 0 1px4px rgba(0,0,0,0.08); display: flex; flex-direction: column; gap: 4px; }
    .price-bond { font-weight: 600; font-size: 0.875rem; }
    .price-best { font-size: 0.8125rem; color: #22c55e; }
    .price-avg { font-size: 0.75rem; color: #6b7280; }
    .loading-section { display: flex; justify-content: center; padding: 48px 0; }
    .empty-section { text-align: center; padding: 48px 0; color: #6b7280; }
    .orders-section { margin-bottom: 32px; }
    .section-header { display: flex; justify-content: space-between; align-items: center;margin-bottom: 12px; }
    .my-orders { margin-top: 32px; padding-top: 24px; border-top: 1px solid #e5e7eb; }
    .orders-table-wrapper { overflow-x: auto; background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .orders-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    .orders-table th { text-align: left; padding: 12px 16px; font-weight: 600; color: #6b7280; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; border-bottom:1px solid #e5e7eb; background: #f9fafb; }
    .orders-table td { padding: 12px 16px; border-bottom: 1px solid #f0f2f5; }
    .orders-table tr:last-child td { border-bottom: none; }
    .mono { font-family: monospace; font-size: 0.8125rem; }
    .btn { padding: 8px 16px; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; text-decoration: none; display: inline-block; }
    .btn-sm { padding: 6px 12px; font-size: 0.8125rem; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #2a2a4e; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-outline { background: #fff; color: #1a1a2e; border: 1px solid #d1d5db; }
    .btn-outline:hover { background: #f0f2f5; }
    .buy-form { display: flex; flex-direction: column; gap: 6px; min-width: 180px; }
    .buy-input { padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.8125rem; outline: none; width: 100%; }
    .buy-input:focus { border-color: #3b82f6; }
    .buy-actions { display: flex; gap: 4px; }
    .buy-requirement { display: flex; flex-direction: column; gap: 6px; font-size: 0.75rem; padding: 8px; border-radius: 6px; }
    .sufficient-msg { color: #22c55e; }
    .insufficient-msg { color: #ef4444; }
    .error-msg { font-size: 0.75rem; color: #ef4444; }
    .expiry-soon { color: #f59e0b; font-weight: 600; }
    .expiry-expired { color: #9ca3af; text-decoration: line-through; }
    .expiry-expired-label { color: #9ca3af; font-size: 0.8125rem; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarketplaceListComponent implements OnInit {
  private readonly apiService = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly authService = inject(AuthService);
  readonly walletService = inject(WalletService);

  readonly orders = signal<Order[]>([]);
  readonly bonds = signal<Bond[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly filterBondId = signal<number | null>(null);

  readonly buyOrderId = signal<number | null>(null);
  readonly buySubmitting = signal(false);
  readonly buyError = signal('');
  buyAmount = 0;
  buyMaxPrice = 0;

  readonly balances = signal<QuoteBalances>({ USDC: 0, XLM: 0 });
  readonly balancesLoaded = signal(false);
  quotePanel?: QuoteBalanceComponent;

  /**
   * A single shared clock tick, driving every order's countdown from one
   * interval rather than one timer per visible row. `startWith(0)` fires
   * immediately so countdowns render on first paint instead of waiting a
   * full second for the first tick.
   */
  private readonly now = toSignal(
    interval(1000).pipe(
      startWith(0),
      map(() => Date.now()),
    ),
    { initialValue: Date.now() },
  );

  readonly bestPrices = computed(() => {
    const orders = this.orders();
    const grouped = new Map<number, Order[]>();
    orders.filter(o => o.status === 'Open').forEach(o => {
      const list = grouped.get(o.bondId) || [];
      list.push(o);
      grouped.set(o.bondId, list);
    });
    const result: Record<number, { best: number; average: number }> = {};
    grouped.forEach((list, bondId) => {
      const prices = list.map(o => o.pricePerToken);
      result[bondId] = {
        best: Math.min(...prices),
        average: prices.reduce((a, b) => a + b, 0) / prices.length,
      };
    });
    return result;
  });

  readonly priceKeys = computed(() => Object.keys(this.bestPrices()).map(Number));

  readonly filteredOrders = computed(() => {
    const selected = this.filterBondId();
    return selected ? this.orders().filter(o => o.bondId === selected) : this.orders();
  });

  readonly myOrders = computed(() => {
    const address = this.walletService.address();
    if (!address) return [];
    return this.orders().filter(o => o.seller === address);
  });

  ngOnInit(): void {
    const bondIdParam = this.route.snapshot.queryParamMap.get('bondId');
    if (bondIdParam) {
      this.filterBondId.set(Number(bondIdParam));
    }
    this.loadBonds();
    this.loadOrders();
  }

  private loadBonds(): void {
    this.apiService.getBonds(1, 100).subscribe({
      next: (res) => this.bonds.set(res.data),
    });
  }

  private loadOrders(): void {
    this.loading.set(true);
    this.error.set('');
    this.apiService.getOrders(this.filterBondId() ?? undefined).subscribe({
      next: (res) => {
        this.orders.set(res.data);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Failed to load orders');
        this.loading.set(false);
      },
    });
  }

  onFilterChange(bondId: number | null): void {
    this.filterBondId.set(bondId);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: bondId ? { bondId } : {},
      queryParamsHandling: 'merge',
    });
    this.loadOrders();
  }

  openBuy(order: Order): void {
    this.buyOrderId.set(order.id);
    this.buyAmount = 0;
    this.buyMaxPrice = 0;
    this.buyError.set('');
    this.quotePanel?.loadBalances();
  }

  cancelBuy(): void {
    this.buyOrderId.set(null);
  }

  onBalancesChange(balances: QuoteBalances): void {
    this.balances.set(balances);
    this.balancesLoaded.set(true);
  }

  buyRequirement(order: Order): {
    required: number;
    available: number;
    shortfall: number;
    asset: QuoteAsset;
    sufficient: boolean;
  } | null {
    if (this.buyOrderId() !== order.id || !this.balancesLoaded()) return null;
    if (!this.buyAmount || this.buyAmount < 1 || !this.buyMaxPrice || this.buyMaxPrice <=0) return null;

    const asset = order.quoteAsset;
    const required = this.buyAmount * order.pricePerToken;
    const available = this.balances()[asset] ?? 0;
    return {
      required,
      available,
      shortfall: Math.max(0, required - available),
      asset,
      sufficient: available >= required,
    };
  }

  canConfirm(order: Order): boolean {
    if (!this.balancesLoaded()) return true;
    return this.buyRequirement(order)?.sufficient ?? false;
  }

  focusQuotePanel(): void {
    document.getElementById('quote-balance')?.scrollIntoView({ behavior: 'smooth', block:'center' });
  }

  /**
   * Seconds remaining until `order` expires, floored at 0. `expiresAt`
   * comes from the contract as Unix seconds, so it's multiplied by 1000
   * to compare against `Date.now()` — done in exactly one place to avoid
   * an off-by-1000 unit error creeping in elsewhere.
   */
  secondsRemaining(order: Order): number {
    const remainingMs = order.expiresAt * 1000 - this.now();
    return Math.max(0, Math.floor(remainingMs / 1000));
  }

  isExpired(order: Order): boolean {
    return this.secondsRemaining(order) <= 0;
  }

  isExpiringSoon(order: Order): boolean {
    const remaining = this.secondsRemaining(order);
    return remaining > 0 && remaining <= EXPIRY_WARNING_THRESHOLD_S;
  }

  formatCountdown(seconds: number): string {
    if (seconds <= 0) return 'Expired';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  onBuy(order: Order): void {
    if (!this.buyAmount || this.buyAmount < 1 || !this.buyMaxPrice || this.buyMaxPrice <=0) return;
    if (this.isExpired(order)) {
      this.buyError.set('This order has expired.');
      return;
    }
    this.buySubmitting.set(true);
    this.buyError.set('');

    this.apiService.buyBondTokens({
      orderId: order.id,
      amount: this.buyAmount,
      maxPrice: this.buyMaxPrice,
    }).subscribe({
      next: () => {
        this.buyOrderId.set(null);
        this.buySubmitting.set(false);
        this.quotePanel?.loadBalances();
        this.loadOrders();
      },
      error: (err) => {
        this.buyError.set(err.error?.detail || err.message || 'Buy failed');
        this.buySubmitting.set(false);
      },
    });
  }
}
