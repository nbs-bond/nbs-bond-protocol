import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { WalletService } from './wallet.service';
import { AuthService } from './auth.service';
import { FreighterInstallPromptComponent } from './freighter-install-prompt.component';

@Component({
  selector: 'app-auth',
  standalone: true,
  imports: [CommonModule, FreighterInstallPromptComponent],
  template: `
    <div class="auth-page">
      <div class="auth-card">
        <h1>NbS Bond Protocol</h1>
        <p class="subtitle">Sign in with your Stellar wallet</p>

        <ng-container *ngIf="!walletService.isConnected()">
          <button class="btn btn-primary" (click)="connect()" [disabled]="walletService.isConnecting()">
            {{ walletService.isConnecting() ? 'Connecting...' : 'Connect Wallet' }}
          </button>
        </ng-container>

        <ng-container *ngIf="walletService.isConnected()">
          <div class="wallet-address">
            Connected: {{ walletService.address()?.slice(0, 6) }}...{{ walletService.address()?.slice(-4) }}
          </div>
          <button class="btn btn-primary" (click)="signIn()">
            Sign In with Stellar
          </button>
        </ng-container>

        <app-freighter-install-prompt
          *ngIf="walletService.needsInstall()"
          (retry)="connect()"
        />

        <p *ngIf="errorMessage()" class="error">{{ errorMessage() }}</p>
      </div>
    </div>
  `,
  styles: [`
    .auth-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .auth-card { background: #fff; border-radius: 12px; padding: 40px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 400px; width: 100%; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    .subtitle { color: #666; margin-bottom: 24px; }
    .wallet-address { background: #f0f2f5; padding: 8px 16px; border-radius: 8px; margin-bottom: 16px; font-family: monospace; font-size: 0.875rem; }
    .btn { padding: 12px 24px; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; width: 100%; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #ef4444; margin-top: 12px; font-size: 0.875rem; }
    app-freighter-install-prompt { display: block; margin-top: 16px; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthComponent {
  private readonly router = inject(Router);
  readonly walletService = inject(WalletService);
  readonly authService = inject(AuthService);

  private readonly signInError = signal('');

  /** A missing extension is reported by the install prompt, not as plain error text. */
  readonly errorMessage = computed(() => {
    const walletError = this.walletService.error();
    if (walletError && walletError.kind !== 'not-installed') return walletError.message;
    return this.signInError();
  });

  /** `connect()` resolves rather than rejecting, so a failure always reaches the UI. */
  async connect(): Promise<void> {
    this.signInError.set('');
    await this.walletService.connect();
  }

  async signIn(): Promise<void> {
    this.signInError.set('');
    try {
      await this.authService.login();
      await this.router.navigate(['/dashboard']);
    } catch (e: any) {
      this.signInError.set(e.message || 'Sign in failed');
    }
  }
}
