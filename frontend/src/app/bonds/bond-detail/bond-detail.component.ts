import {
  Component,
  inject,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  signal,
  computed,
  effect,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import { RouterModule, ActivatedRoute } from "@angular/router";
import { FormsModule } from "@angular/forms";
import { ApiService } from "../../shared/services/api.service";
import { WalletService } from "../../auth/wallet.service";
import { StatusBadgeComponent } from "../../shared/components/status-badge/status-badge.component";
import { LoadingSpinnerComponent } from "../../shared/components/loading-spinner/loading-spinner.component";
import { Bond } from "../../shared/interfaces/bond.interface";
import { AccruedCreditsResponse } from "../../shared/interfaces/bond.interface";
import { environment } from "../../../environments/environment";
import { isValidStellarAddress } from "../../shared/validators/form-validators";

export type ActionState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: T }
  | { status: "error"; error: string };

export function isSuccess<T>(
  state: ActionState<T>,
): state is { status: "success"; result: T } {
  return state.status === "success";
}

export function isError<T>(
  state: ActionState<T>,
): state is { status: "error"; error: string } {
  return state.status === "error";
}

export function isLoading<T>(
  state: ActionState<T>,
): state is { status: "loading" } {
  return state.status === "loading";
}

// Safe accessor functions
export function getError<T>(state: ActionState<T>): string {
  return isError(state) ? state.error : "";
}

export function getResult<T>(state: ActionState<T>): T | undefined {
  return isSuccess(state) ? state.result : undefined;
}

@Component({
  selector: "app-bond-detail",
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    FormsModule,
    StatusBadgeComponent,
    LoadingSpinnerComponent,
  ],
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
                Maturity date ({{ b.maturityDate * 1000 | date: "mediumDate" }})
                has been reached. Subscriptions and transfers are disabled.
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
                <span class="field-value">{{
                  b.maturityDate * 1000 | date
                }}</span>
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
              <h3 class="section-title">
                Coupon Schedule ({{ b.couponSchedule.length }} payments)
              </h3>
              <ul class="coupon-list">
                @for (ts of b.couponSchedule; track ts; let i = $index) {
                  <li class="coupon-item">
                    <span class="coupon-index">Period {{ i + 1 }}</span>
                    <span class="coupon-date">{{ ts * 1000 | date }}</span>
                  </li>
                }
              </ul>
            </div>
          </div>

          <div class="detail-card sidebar">
            <h3 class="section-title">Subscription Progress</h3>
            <div class="progress-bar">
              <div
                class="progress-fill"
                [style.width.%]="subscribeProgress()"
              ></div>
            </div>
            <div class="progress-text">
              {{ b.totalSubscribed | number }} /
              {{ b.totalSupply | number }} ({{ subscribeProgress() }}%)
            </div>

            <div class="subscribe-section">
              <h3 class="section-title">Subscribe</h3>
              @if (b.status !== "Active" || maturityReached()) {
                @if (maturityReached()) {
                  <p class="status-notice">
                    This bond has reached maturity and is frozen for trading.
                  </p>
                } @else {
                  <p class="status-notice">
                    This bond is {{ b.status }} and is not accepting new
                    subscriptions.
                  </p>
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
                    [disabled]="
                      !subscribeAmount || subscribeAmount < 1 || isSubscribing()
                    "
                    (click)="onSubscribe()"
                  >
                    {{ isSubscribing() ? "Subscribing..." : "Subscribe" }}
                  </button>
                  @if (subscribeSuccess()) {
                    <div class="success-msg">
                      Subscribed! Tx: {{ subscribeTx() }}
                    </div>
                  }
                  @if (subscribeError()) {
                    <div class="error-msg">{{ subscribeError() }}</div>
                  }
                </div>
              }
            </div>

            <div class="marketplace-link">
              <a
                class="btn btn-outline"
                [routerLink]="['/marketplace']"
                [queryParams]="{ bondId: b.id }"
              >
                View on Marketplace
              </a>
            </div>

            <div class="claim-section">
              <h3 class="section-title">Claim Credits</h3>
              @if (accrued(); as accruedRes) {
                <p class="accrued-summary">
                  Accrued credits: <strong>{{ accruedRes.total }}</strong>
                  @for (
                    entry of accruedRes.perCreditType;
                    track entry.creditType
                  ) {
                    <span class="accrued-type"
                      >{{ entry.creditType }}: {{ entry.amount }}</span
                    >
                  }
                </p>
              } @else if (accruedError()) {
                <p class="error-msg">{{ accruedError() }}</p>
              }
              <button
                class="btn btn-primary claim-btn"
                [disabled]="isClaiming() || !canClaim()"
                (click)="onClaim()"
              >
                @if (isClaiming()) {
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
                <p class="claim-hint">
                  No credits accrued yet — nothing to claim.
                </p>
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
                <p class="status-notice">
                  Transfers are disabled after the maturity date.
                </p>
              } @else {
                <div class="subscribe-form">
                  <label class="form-label" for="transferTo"
                    >Recipient Address</label
                  >
                  <input
                    id="transferTo"
                    type="text"
                    class="form-input"
                    [value]="transferTo()"
                    (input)="transferTo.set($any($event.target).value)"
                    placeholder="G... recipient public key"
                  />
                  @if (transferTo() && !transferToValid()) {
                    <span class="form-error">
                      Enter a valid Stellar address (G… followed by 55 uppercase letters/digits)
                    </span>
                  }
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
                    [disabled]="
                      !transferTo() ||
                      !transferToValid() ||
                      !transferAmount ||
                      transferAmount < 1 ||
                      isTransferring()
                    "
                    (click)="onTransfer()"
                  >
                    {{ isTransferring() ? "Transferring..." : "Transfer" }}
                  </button>
                  @if (transferSuccess()) {
                    <div class="success-msg">
                      Transferred {{ transferAmount }} tokens! Tx: {{ transferTx() }}
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
                  Integer-division remainder from coupon distributions,
                  recoverable via sweep.
                </p>
                @if (undistributed() !== null) {
                  <div class="undistributed-total">
                    <span class="field-label">Undistributed Total</span>
                    <span class="field-value">{{
                      undistributed() | number
                    }}</span>
                  </div>
                  <button
                    class="btn btn-primary sweep-btn"
                    [disabled]="undistributed() === 0 || isSweeping()"
                    (click)="onSweep()"
                  >
                    {{ isSweeping() ? "Sweeping..." : "Sweep Undistributed" }}
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
  styles: [
    `
      .detail-page {
        max-width: 1200px;
      }
      .back-link {
        display: inline-block;
        margin-bottom: 24px;
        color: #3b82f6;
        text-decoration: none;
        font-size: 0.875rem;
      }
      .back-link:hover {
        text-decoration: underline;
      }
      .loading-section {
        display: flex;
        justify-content: center;
        padding: 48px 0;
      }
      .error-card {
        background: #fef2f2;
        color: #ef4444;
        padding: 24px;
        border-radius: 12px;
        text-align: center;
      }
      .detail-grid {
        display: grid;
        grid-template-columns: 1fr 360px;
        gap: 24px;
      }
      .detail-card {
        background: #fff;
        border-radius: 12px;
        padding: 32px;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
      }
      .detail-card.sidebar {
        padding: 24px;
      }
      .detail-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 24px;
      }
      .detail-title {
        font-size: 1.5rem;
        font-weight: 700;
      }
      .maturity-banner {
        display: flex;
        gap: 8px;
        padding: 12px 16px;
        border-radius: 8px;
        background: #fffbeb;
        border: 1px solid #fde68a;
        color: #92400e;
        font-size: 0.875rem;
        margin-bottom: 24px;
      }
      .maturity-banner.frozen {
        background: #fef2f2;
        border-color: #fecaca;
        color: #991b1b;
      }
      .detail-body {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
      }
      .detail-field {
        display: flex;
        flex-direction: column;
      }
      .field-label {
        font-size: 0.75rem;
        color: #6b7280;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
      }
      .field-value {
        font-size: 0.9375rem;
        color: #1a1a2e;
      }
      .field-value.mono {
        font-family: monospace;
        font-size: 0.8125rem;
        word-break: break-all;
      }
      .section-title {
        font-size: 1rem;
        font-weight: 600;
        margin-bottom: 12px;
      }
      .coupon-section {
        margin-top: 24px;
        padding-top: 20px;
        border-top: 1px solid #e5e7eb;
      }
      .coupon-list {
        list-style: none;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .coupon-item {
        display: flex;
        justify-content: space-between;
        padding: 8px 12px;
        background: #f9fafb;
        border-radius: 6px;
        font-size: 0.8125rem;
      }
      .coupon-index {
        color: #6b7280;
      }
      .coupon-date {
        font-weight: 500;
      }
      .progress-bar {
        height: 8px;
        background: #e5e7eb;
        border-radius: 4px;
        overflow: hidden;
        margin-bottom: 8px;
      }
      .progress-fill {
        height: 100%;
        background: #22c55e;
        border-radius: 4px;
        transition: width 0.3s;
      }
      .progress-text {
        font-size: 0.8125rem;
        color: #6b7280;
        margin-bottom: 20px;
      }
      .subscribe-section {
        margin-top: 20px;
        padding-top: 20px;
        border-top: 1px solid #e5e7eb;
      }
      .subscribe-form {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .form-label {
        font-size: 0.8125rem;
        font-weight: 600;
        color: #1a1a2e;
      }
      .form-input {
        padding: 10px 12px;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        font-size: 0.875rem;
        outline: none;
      }
      .form-input:focus {
        border-color: #3b82f6;
        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15);
      }
      .status-notice {
        font-size: 0.8125rem;
        color: #6b7280;
        padding: 8px 0;
      }
      .btn {
        padding: 10px 20px;
        border-radius: 8px;
        font-size: 0.875rem;
        font-weight: 500;
        cursor: pointer;
        border: none;
        text-decoration: none;
        display: inline-block;
        text-align: center;
      }
      .btn-primary {
        background: #1a1a2e;
        color: #fff;
      }
      .btn-primary:hover:not(:disabled) {
        background: #2a2a4e;
      }
      .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-outline {
        background: #fff;
        color: #1a1a2e;
        border: 1px solid #d1d5db;
        width: 100%;
      }
      .btn-outline:hover {
        background: #f0f2f5;
      }
      .subscribe-btn {
        width: 100%;
      }
      .success-msg {
        font-size: 0.8125rem;
        color: #22c55e;
        word-break: break-all;
        padding: 8px;
        background: #f0fdf4;
        border-radius: 6px;
      }
      .error-msg {
        font-size: 0.8125rem;
        color: #ef4444;
        padding: 8px;
        background: #fef2f2;
        border-radius: 6px;
      }
      .marketplace-link {
        margin-top: 20px;
      }
      .claim-section {
        margin-top: 20px;
        padding-top: 20px;
        border-top: 1px solid #e5e7eb;
      }
      .claim-btn,
      .transfer-btn,
      .sweep-btn {
        width: 100%;
      }
      .transfer-section {
        margin-top: 20px;
        padding-top: 20px;
        border-top: 1px solid #e5e7eb;
      }
      .admin-section {
        margin-top: 20px;
        padding-top: 20px;
        border-top: 1px solid #e5e7eb;
      }
      .admin-note {
        font-size: 0.8125rem;
        color: #6b7280;
        padding: 8px 0;
      }
      .undistributed-total {
        display: flex;
        flex-direction: column;
        margin-bottom: 12px;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BondDetailComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly apiService = inject(ApiService);
  private readonly walletService = inject(WalletService);

  readonly bond = signal<Bond | null>(null);
  readonly loading = signal(true);
  readonly error = signal("");
  readonly now = signal(Date.now());

  // Action states - each action is a state machine
  readonly subscribeState = signal<ActionState<{ tx: string }>>({
    status: "idle",
  });
  readonly claimState = signal<ActionState<{ credits: number; tx: string }>>({
    status: "idle",
  });
  readonly transferState = signal<ActionState<{ tx: string }>>({
    status: "idle",
  });
  readonly sweepState = signal<ActionState<{ swept: number; tx: string }>>({
    status: "idle",
  });

  // Data signals
  readonly undistributed = signal<number | null>(null);
  readonly undistributedError = signal("");
  readonly accrued = signal<AccruedCreditsResponse | null>(null);
  readonly accruedError = signal("");

  // Computed helpers for template
  readonly isSubscribing = computed(() => isLoading(this.subscribeState()));
  readonly subscribeSuccess = computed(() => isSuccess(this.subscribeState()));
  readonly subscribeError = computed(() => getError(this.subscribeState()));
  readonly subscribeTx = computed(
    () => getResult(this.subscribeState())?.tx || "",
  );

  readonly isClaiming = computed(() => isLoading(this.claimState()));
  readonly claimSuccess = computed(() => isSuccess(this.claimState()));
  readonly claimError = computed(() => getError(this.claimState()));
  readonly claimCredits = computed(
    () => getResult(this.claimState())?.credits || 0,
  );
  readonly claimTx = computed(() => getResult(this.claimState())?.tx || "");

  readonly isTransferring = computed(() => isLoading(this.transferState()));
  readonly transferSuccess = computed(() => isSuccess(this.transferState()));
  readonly transferError = computed(() => getError(this.transferState()));
  readonly transferTx = computed(
    () => getResult(this.transferState())?.tx || "",
  );

  readonly isSweeping = computed(() => isLoading(this.sweepState()));
  readonly sweepSuccess = computed(() => isSuccess(this.sweepState()));
  readonly sweepError = computed(() => getError(this.sweepState()));
  readonly sweepSwept = computed(
    () => getResult(this.sweepState())?.swept || 0,
  );
  readonly sweepTx = computed(() => getResult(this.sweepState())?.tx || "");

  readonly isAdmin = computed(
    () => this.walletService.address() === environment.adminAddress,
  );

  readonly maturityReached = computed(() => {
    const b = this.bond();
    return (
      !!b &&
      (b.maturityStatus === "Matured" || b.maturityDate * 1000 <= this.now())
    );
  });

  readonly countdown = computed(() => {
    const b = this.bond();
    if (!b || this.maturityReached()) return "";
    return this.formatCountdown(b.maturityDate * 1000 - this.now());
  });

  private maturityTimer?: ReturnType<typeof setInterval>;

  // Computed signal that tracks when to load undistributed data
  private readonly shouldLoadUndistributed = computed(() => {
    const b = this.bond();
    return b && this.isAdmin();
  });

  // Effect that reacts to the computed signal
  private readonly loadUndistributedEffect = effect(
    () => {
      if (this.shouldLoadUndistributed()) {
        const b = this.bond();
        if (b) {
          this.apiService.getUndistributedTotal(b.id).subscribe({
            next: (res) => this.undistributed.set(res.undistributedTotal),
            error: (err) =>
              this.undistributedError.set(
                err.error?.detail ||
                  err.message ||
                  "Failed to load undistributed total",
              ),
          });
        }
      }
    },
    { allowSignalWrites: true },
  );

  // Computed signal that tracks when to load accrued credits
  private readonly shouldLoadAccrued = computed(() => {
    const b = this.bond();
    const holder = this.walletService.address();
    return b && holder;
  });

  // Effect that reacts to the computed signal
  private readonly loadAccruedEffect = effect(
    () => {
      if (this.shouldLoadAccrued()) {
        const b = this.bond();
        const holder = this.walletService.address();
        if (b && holder) {
          this.apiService.getAccruedCredits(b.id, holder).subscribe({
            next: (res) => this.accrued.set(res),
            error: (err) =>
              this.accruedError.set(
                err.error?.detail ||
                  err.message ||
                  "Failed to load accrued credits",
              ),
          });
        }
      }
    },
    { allowSignalWrites: true },
  );

  readonly canClaim = computed(() => (this.accrued()?.total ?? 0) > 0);

  private refreshAccrued(): void {
    // The computed signal will trigger the effect automatically
    // We just need to ensure the effect runs
    // Force a refresh by manually calling the API
    const b = this.bond();
    const holder = this.walletService.address();
    if (!b || !holder) return;
    this.apiService.getAccruedCredits(b.id, holder).subscribe({
      next: (res) => this.accrued.set(res),
      error: () => this.accrued.set(null),
    });
  }

  subscribeAmount = 0;
  transferTo = signal('');
  readonly transferToValid = computed(() => isValidStellarAddress(this.transferTo()));
  transferAmount = 0;

  subscribeProgress(): number {
    const b = this.bond();
    if (!b || b.totalSupply === 0) return 0;
    return Math.round((b.totalSubscribed / b.totalSupply) * 100);
  }

  formatCountdown(ms: number): string {
    if (ms <= 0) return "";
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
    return parts.join(" ");
  }

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get("id"));
    if (!id) {
      this.error.set("Invalid bond ID");
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
        this.error.set(
          err.status === 404 ? "Bond not found" : "Failed to load bond",
        );
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
    this.subscribeState.set({ status: "loading" });

    this.apiService.subscribeToBond(b.id, this.subscribeAmount).subscribe({
      next: (res) => {
        this.subscribeState.set({
          status: "success",
          result: { tx: res.transactionHash },
        });
        this.apiService.getBond(b.id).subscribe({
          next: (updated) => this.bond.set(updated),
        });
        this.subscribeAmount = 0;
      },
      error: (err) => {
        this.subscribeState.set({
          status: "error",
          error: err.error?.detail || err.message || "Subscription failed",
        });
      },
    });
  }

  onClaim(): void {
    const b = this.bond();
    if (!b) return;
    this.claimState.set({ status: "loading" });

    this.apiService.claimCredits(b.id).subscribe({
      next: (res) => {
        this.claimState.set({
          status: "success",
          result: { credits: res.credits, tx: res.transactionHash },
        });
        this.refreshAccrued();
      },
      error: (err) => {
        this.claimState.set({
          status: "error",
          error: err.error?.detail || err.message || "Claim failed",
        });
      },
    });
  }

  onTransfer(): void {
    const b = this.bond();
    if (
      !b ||
      !this.transferTo() ||
      !this.transferToValid() ||
      !this.transferAmount ||
      this.transferAmount < 1
    )
      return;
    this.transferState.set({ status: "loading" });

    this.apiService
      .transferBond(b.id, this.transferTo(), this.transferAmount)
      .subscribe({
        next: (res) => {
          this.transferState.set({
            status: "success",
            result: { tx: res.transactionHash },
          });
          this.transferTo.set('');
          this.transferAmount = 0;
        },
        error: (err) => {
          this.transferState.set({
            status: "error",
            error: err.error?.detail || err.message || "Transfer failed",
          });
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

    this.sweepState.set({ status: "loading" });

    this.apiService.sweepUndistributed(b.id).subscribe({
      next: (res) => {
        this.sweepState.set({
          status: "success",
          result: { swept: res.swept, tx: res.transactionHash },
        });
        this.undistributed.set(0);
      },
      error: (err) => {
        this.sweepState.set({
          status: "error",
          error: err.error?.detail || err.message || "Sweep failed",
        });
      },
    });
  }
}
