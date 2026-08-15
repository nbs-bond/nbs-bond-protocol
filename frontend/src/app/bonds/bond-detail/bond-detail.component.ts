import { Component, inject, OnInit, OnDestroy, ChangeDetectionStrategy, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../shared/services/api.service';
import { WalletService } from '../../auth/wallet.service';
import { StatusBadgeComponent } from '../../shared/components/status-badge/status-badge.component';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner.component';
import { Bond } from '../../shared/interfaces/bond.interface';
import { AccruedCreditsResponse } from '../../shared/interfaces/bond.interface';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-bond-detail',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, StatusBadgeComponent, LoadingSpinnerComponent],
  template: `
    <div class="detail-page">
      <a class="back-link" routerLink="/bonds">← Back to Bonds</a>

      @if (bond(); as b) {
        <div class="detail-grid">
          <div class="detail-card main">
            <div class="detail-header">
              <h1 class="detail-title">Bond #{{ b.id }}</h1>
              <app-status-badge [status]="b.status" variant="bond" />
            </div>

            <div class="maturity-banner" [class.frozen]="maturityReached()">
              @if (maturityReached()) {
                <strong>Frozen for trading.</strong>
                Maturity date ({{ b.maturityDate * 1000 | date:'mediumDate' }}) has been reached.
                Subscriptions and transfers are disabled.
              } @else {
                <strong>Matures in:</strong> {{ countdown() }}
              }
            </div>

            <div class="detail-body">
              <div class="detail-field">
                <span class="field-label">Project ID</span>
                <span class="field-value mono">{{ b.projectId }}</span>
              </div>
              <div class="detail-field">
                <span class="field-label">Face Value</span>
                <span class="field-value">{{ b.faceValue | number }}</span>
              </div>
              <div class="detail-field">
                <span class="field-label">Credit Type</span>
                <span class="field-value">{{ b.creditType }}</span>
              </div>
              <div class="detail-field">
                <span class="field-label">Maturity Date</span>
                <span class="field-value">{{ b.maturityDate * 1000 | date }}</span>
              </div>
              <div class="detail-field">
                <span class="field-label">Total Supply</span>
                <span class="field-value">{{ b.totalSupply | number }}</span>
              </div>
              <div class="detail-field">
                <span class="field-label">Created</span>
                <span class="field-value">{{ b.createdAt | date }}</span>
              </div>
            </div>

            <div class="coupon-section">
              <h3 class="section-title">Coupon Schedule ({{ b.couponSchedule.length }} payments)</h3>
              <ul class="coupon-list">
                @for (ts of b.couponSchedule; track ts; let i = $index) {
                  <li class="coupon-item">
                    <span class="coupon-index">Period {{ i + 1 }}</span>
                    <span class="coupon-date">{{ ts | date }}</span>
                  </li>
                }
              </ul>
            </div>
          </div>

          <div class="detail-card sidebar">
            <h3 class="section-title">Subscription Progress</h3>
            <div class="progress-bar">
              <div class="progress-fill" [style.width.%]="subscribeProgress()"></div>
            </div>
            <div class="progress-text">
              {{ b.totalSubscribed | number }} / {{ b.totalSupply | number }}
              ({{ subscribeProgress() }}%)
            </div>

            <div class="subscribe-section">
              <h3 class="section-title">Subscribe</h3>
              @if (b.status !== 'Active' || maturityReached()) {
                @if (maturityReached()) {
                  <p class="status-notice">This bond has reached maturity and is frozen for trading.</p>
                } @else {
                  <p class="status-notice">This bond is {{ b.status }} and is not accepting new subscriptions.</p>
                }
              } @else {
                <div class="subscribe-form">
                  <label class="form-label" for="amount">Amount</label>
                  <input
                    id="amount"
                    type="number"
                    class="form-input"
                    [(ngModel)]="subscribeAmount"
                    placeholder="Enter amount"
                    min="1"
                  />
                  <button
                    class="btn btn-primary subscribe-btn"
                    [disabled]="!subscribeAmount || subscribeAmount < 1 || subscribeSubmitting()"
                    (click)="onSubscribe()"
                  >
                    {{ subscribeSubmitting() ? 'Subscribing...' : 'Subscribe' }}
                  </button>
                  @if (subscribeSuccess()) {
                    <div class="success-msg">Subscribed! Tx: {{ subscribeTx() }}</div>
                  }
                  @if (subscribeError()) {
                    <div class="error-msg">{{ subscribeError() }}</div>
                  }
                </div>
              }
            </div>

            <div class="marketplace-link">
              <a class="btn btn-outline" [routerLink]="['/marketplace']" [queryParams]="{ bondId: b.id }">
                View on Marketplace
              </a>
            </div>

            <div class="claim-section">
              <h3 class="section-title">Claim Credits</h3>
              @if (accrued(); as accruedRes) {
                <p class="accrued-summary">
                  Accrued credits: <strong>{{ accruedRes.total }}</strong>
                  @for (entry of accruedRes.perCreditType; track entry.creditType) {
                    <span class="accrued-type">{{ entry.creditType }}: {{ entry.amount }}</span>
                  }
                </p>
              } @else if (accruedError()) {
                <p class="error-msg">{{ accruedError() }}</p>
              }
              <button
                class="btn btn-primary claim-btn"
                [disabled]="claimSubmitting() || !canClaim()"
                (click)="onClaim()"
              >
                @if (claimSubmitting()) {
                  Claiming...
                } @else {
                  @if (accrued(); as accruedRes) {
                    Claim {{ accruedRes.total }} Accrued Credits
                  } @else {
                    Claim Accrued Credits
                  }
                }
              </button>
              @if (accrued() && !canClaim()) {
                <p class="claim-hint">No credits accrued yet — nothing to claim.</p>
              }
              @if (claimSuccess()) {
                <div class="success-msg">
                  Claimed {{ claimCredits() }} credits! Tx: {{ claimTx() }}
                </div>
              }
              @if (claimError()) {
                <div class="error-msg">{{ claimError() }}</div>
              }
            </div>

            <div class="transfer-section">
              <h3 class="section-title">Transfer Tokens</h3>
              @if (maturityReached()) {
                <p class="status-notice">Transfers are disabled after the maturity date.</p>
              } @else {
                <div class="subscribe-form">
                  <label class="form-label" for="transferTo">Recipient Address</label>
                  <input
                    id="transferTo"
                    type="text"
                    class="form-input"
                    [(ngModel)]="transferTo"
                    placeholder="G... recipient public key"
                  />
                  <label class="form-label" for="transferAmount">Amount</label>
                  <input
                    id="transferAmount"
                    type="number"
                    class="form-input"
                    [(ngModel)]="transferAmount"
                    placeholder="Enter amount"
                    min="1"
                  />
                  <button
                    class="btn btn-primary transfer-btn"
                    [disabled]="!transferTo || !transferAmount || transferAmount < 1 || transferSubmitting()"
                    (click)="onTransfer()"
                  >
                    {{ transferSubmitting() ? 'Transferring...' : 'Transfer' }}
                  </button>
                  @if (transferSuccess()) {
                    <div class="success-msg">
                      Transferred {{ transferAmount }} tokens to {{ transferTo }}! Tx: {{ transferTx() }}
                    </div>
                  }
                  @if (transferError()) {
                    <div class="error-msg">{{ transferError() }}</div>
                  }
                </div>
              }
            </div>

            @if (isAdmin()) {
              <div class="admin-section">
                <h3 class="section-title">Admin: Undistributed Coupons</h3>
                <p class="admin-note">
                  Integer-division remainder from coupon distributions, recoverable via sweep.
                </p>
                @if (undistributed() !== null) {
                  <div class="undistributed-total">
                    <span class="field-label">Undistributed Total</span>
                    <span class="field-value">{{ undistributed() | number }}</span>
                  </div>
                  <button
                    class="btn btn-primary sweep-btn"
                    [disabled]="undistributed() === 0 || sweepSubmitting()"
                    (click)="onSweep()"
                  >
                    {{ sweepSubmitting() ? 'Sweeping...' : 'Sweep Undistributed' }}
                  </button>
                } @else if (undistributedError()) {
                  <div class="error-msg">{{ undistributedError() }}</div>
                } @else {
                  <div class="admin-note">Loading undistributed total...</div>
                }
                @if (sweepSuccess()) {
                  <div class="success-msg">
                    Swept {{ sweepSwept() }} credits! Tx: {{ sweepTx() }}
                  </div>
                }
                @if (sweepError()) {
                  <div class="error-msg">{{ sweepError() }}</div>
                }
              </div>
            }
          </div>
        </div>
      } @else if (loading()) {
        <div class="loading-section"><app-loading-spinner size="lg" /></div>
      } @else if (error()) {
        <div class="error-card">{{ error() }}</div>
      }
    </div>
  `,
  styles: [`
    .detail-page { max-width: 1200px; }
    .back-link { display: inline-block; margin-bottom: 24px; color: #3b82f6; text-decoration: none; font-size: 0.875rem; }
    .back-link:hover { text-decoration: underline; }
    .loading-section { display: flex; justify-content: center; padding: 48px 0; }
    .error-card { background: #fef2f2; color: #ef4444; padding: 24px; border-radius: 12px; text-align: center; }
    .detail-grid { display: grid; grid-template-columns: 1fr 360px; gap: 24px; }
    .detail-card { background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .detail-card.sidebar { padding: 24px; }
    .detail-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .detail-title { font-size: 1.5rem; font-weight: 700; }
    .maturity-banner { display: flex; gap: 8px; padding: 12px 16px; border-radius: 8px; background: #fffbeb; border: 1px solid #fde68a; color: #92400e; font-size: 0.875rem; margin-bottom: 24px; }
    .maturity-banner.frozen { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
    .detail-body { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .detail-field { display: flex; flex-direction: column; }
    .field-label { font-size: 0.75rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .field-value { font-size: 0.9375rem; color: #1a1a2e; }
    .field-value.mono { font-family: monospace; font-size: 0.8125rem; word-break: break-all; }
    .section-title { font-size: 1rem; font-weight: 600; margin-bottom: 12px; }
    .coupon-section { margin-top: 24px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
    .coupon-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .coupon-item { display: flex; justify-content: space-between; padding: 8px 12px; background: #f9fafb; border-radius: 6px; font-size: 0.8125rem; }
    .coupon-index { color: #6b7280; }
    .coupon-date { font-weight: 500; }
    .progress-bar { height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
    .progress-fill { height: 100%; background: #22c55e; border-radius: 4px; transition: width 0.3s; }
    .progress-text { font-size: 0.8125rem; color: #6b7280; margin-bottom: 20px; }
    .subscribe-section { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
    .subscribe-form { display: flex; flex-direction: column; gap: 12px; }
    .form-label { font-size: 0.8125rem; font-weight: 600; color: #1a1a2e; }
    .form-input { padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.875rem; outline: none; }
    .form-input:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.15); }
    .status-notice { font-size: 0.8125rem; color: #6b7280; padding: 8px 0; }
    .btn { padding: 10px 20px; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; text-decoration: none; display: inline-block; text-align: center; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #2a2a4e; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-outline { background: #fff; color: #1a1a2e; border: 1px solid #d1d5db; width: 100%; }
    .btn-outline:hover { background: #f0f2f5; }
    .subscribe-btn { width: 100%; }
    .success-msg { font-size: 0.8125rem; color: #22c55e; word-break: break-all; padding: 8px; background: #f0fdf4; border-radius: 6px; }
    .error-msg { font-size: 0.8125rem; color: #ef4444; padding: 8px; background: #fef2f2; border-radius: 6px; }
    .marketplace-link { margin-top: 20px; }
    .claim-section { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
    .claim-btn, .transfer-btn, .sweep-btn { width: 100%; }
    .transfer-section { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
    .admin-section { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
    .admin-note { font-size: 0.8125rem; color: #6b7280; padding: 8px 0; }
    .undistributed-total { display: flex; flex-direction: column; margin-bottom: 12px; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BondDetailComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly apiService = inject(ApiService);
  private readonly walletService = inject(WalletService);

  readonly bond = signal<Bond | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly now = signal(Date.now());
  readonly subscribeSubmitting = signal(false);
  readonly subscribeSuccess = signal(false);
  readonly subscribeTx = signal('');
  readonly subscribeError = signal('');
  readonly claimSubmitting = signal(false);
  readonly claimSuccess = signal(false);
  readonly claimCredits = signal(0);
  readonly claimTx = signal('');
  readonly claimError = signal('');
  readonly transferSubmitting = signal(false);
  readonly transferSuccess = signal(false);
  readonly transferTx = signal('');
  readonly transferError = signal('');
  readonly undistributed = signal<number | null>(null);
  readonly undistributedError = signal('');
  readonly accrued = signal<AccruedCreditsResponse | null>(null);
  readonly accruedError = signal('');
  readonly sweepSubmitting = signal(false);
  readonly sweepSuccess = signal(false);
  readonly sweepSwept = signal(0);
  readonly sweepTx = signal('');
  readonly sweepError = signal('');

  readonly isAdmin = computed(
    () => this.walletService.address() === environment.adminAddress,
  );

  readonly maturityReached = computed(() => {
    const b = this.bond();
    return !!b && (b.maturityStatus === 'Matured' || b.maturityDate * 1000 <= this.now());
  });

  readonly countdown = computed(() => {
    const b = this.bond();
    if (!b || this.maturityReached()) return '';
    return this.formatCountdown(b.maturityDate * 1000 - this.now());
  });

  private maturityTimer?: ReturnType<typeof setInterval>;

  private undistributedLoaded = false;

  private readonly loadUndistributedEffect = effect(() => {
    const b = this.bond();
    if (b && this.isAdmin() && !this.undistributedLoaded) {
      this.undistributedLoaded = true;
      this.apiService.getUndistributedTotal(b.id).subscribe({
        next: (res) => this.undistributed.set(res.undistributedTotal),
        error: (err) =>
          this.undistributedError.set(
            err.error?.detail || err.message || 'Failed to load undistributed total',
          ),
      });
    }
  }, { allowSignalWrites: true });

  private accruedLoadedFor: { bondId: number; holder: string } | null = null;

  private readonly loadAccruedEffect = effect(() => {
    const b = this.bond();
    const holder = this.walletService.address();
    if (!b || !holder) return;
    if (
      this.accruedLoadedFor &&
      this.accruedLoadedFor.bondId === b.id &&
      this.accruedLoadedFor.holder === holder
    ) {
      return;
    }
    this.accruedLoadedFor = { bondId: b.id, holder };
    this.apiService.getAccruedCredits(b.id, holder).subscribe({
      next: (res) => this.accrued.set(res),
      error: (err) =>
        this.accruedError.set(
          err.error?.detail || err.message || 'Failed to load accrued credits',
        ),
    });
  }, { allowSignalWrites: true });

  readonly canClaim = computed(() => (this.accrued()?.total ?? 0) > 0);

  private refreshAccrued(): void {
    const b = this.bond();
    const holder = this.walletService.address();
    if (!b || !holder) return;
    this.apiService.getAccruedCredits(b.id, holder).subscribe({
      next: (res) => this.accrued.set(res),
      error: () => this.accrued.set(null),
    });
  }

  subscribeAmount = 0;
  transferTo = '';
  transferAmount = 0;

  subscribeProgress(): number {
    const b = this.bond();
    if (!b || b.totalSupply === 0) return 0;
    return Math.round((b.totalSubscribed / b.totalSupply) * 100);
  }

  formatCountdown(ms: number): string {
    if (ms <= 0) return '';
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (days > 0 || hours > 0) parts.push(`${hours}h`);
    if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(' ');
  }

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id) {
      this.error.set('Invalid bond ID');
      this.loading.set(false);
      return;
    }
    this.maturityTimer = setInterval(() => this.now.set(Date.now()), 1000);
    this.apiService.getBond(id).subscribe({
      next: (bond) => {
        this.bond.set(bond);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err.status === 404 ? 'Bond not found' : 'Failed to load bond');
        this.loading.set(false);
      },
    });
  }

  ngOnDestroy(): void {
    if (this.maturityTimer) {
      clearInterval(this.maturityTimer);
    }
  }

  onSubscribe(): void {
    const b = this.bond();
    if (!b || !this.subscribeAmount || this.subscribeAmount < 1) return;
    this.subscribeSubmitting.set(true);
    this.subscribeSuccess.set(false);
    this.subscribeError.set('');

    this.apiService.subscribeToBond(b.id, this.subscribeAmount).subscribe({
      next: (res) => {
        this.subscribeSuccess.set(true);
        this.subscribeTx.set(res.transactionHash);
        this.subscribeSubmitting.set(false);
        this.apiService.getBond(b.id).subscribe({
          next: (updated) => this.bond.set(updated),
        });
      },
      error: (err) => {
        this.subscribeError.set(err.error?.detail || err.message || 'Subscription failed');
        this.subscribeSubmitting.set(false);
      },
    });
  }

  onClaim(): void {
    const b = this.bond();
    if (!b) return;
    this.claimSubmitting.set(true);
    this.claimSuccess.set(false);
    this.claimError.set('');

    this.apiService.claimCredits(b.id).subscribe({
      next: (res) => {
        this.claimSuccess.set(true);
        this.claimCredits.set(res.credits);
        this.claimTx.set(res.transactionHash);
        this.claimSubmitting.set(false);
        this.accruedLoadedFor = null;
        this.refreshAccrued();
      },
      error: (err) => {
        this.claimError.set(err.error?.detail || err.message || 'Claim failed');
        this.claimSubmitting.set(false);
      },
    });
  }

  onTransfer(): void {
    const b = this.bond();
    if (!b || !this.transferTo || !this.transferAmount || this.transferAmount < 1) return;
    this.transferSubmitting.set(true);
    this.transferSuccess.set(false);
    this.transferError.set('');

    this.apiService.transferBond(b.id, this.transferTo, this.transferAmount).subscribe({
      next: (res) => {
        this.transferSuccess.set(true);
        this.transferTx.set(res.transactionHash);
        this.transferSubmitting.set(false);
        this.transferTo = '';
        this.transferAmount = 0;
      },
      error: (err) => {
        this.transferError.set(err.error?.detail || err.message || 'Transfer failed');
        this.transferSubmitting.set(false);
      },
    });
  }

  onSweep(): void {
    const b = this.bond();
    const total = this.undistributed();
    if (!b || total === null || total <= 0) return;

    const confirmed = window.confirm(
      `Sweep ${total} undistributed credits from Bond #${b.id}? This will reset the undistributed balance to zero.`,
    );
    if (!confirmed) return;

    this.sweepSubmitting.set(true);
    this.sweepSuccess.set(false);
    this.sweepError.set('');

    this.apiService.sweepUndistributed(b.id).subscribe({
      next: (res) => {
        this.sweepSuccess.set(true);
        this.sweepSwept.set(res.swept);
        this.sweepTx.set(res.transactionHash);
        this.sweepSubmitting.set(false);
        this.undistributed.set(0);
      },
      error: (err) => {
        this.sweepError.set(err.error?.detail || err.message || 'Sweep failed');
        this.sweepSubmitting.set(false);
      },
    });
  }
}
