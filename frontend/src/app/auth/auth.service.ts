import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, finalize, firstValueFrom, map, shareReplay, tap, throwError } from 'rxjs';
import { WalletService } from './wallet.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly walletService = inject(WalletService);

  readonly token = signal<string | null>(localStorage.getItem('nbs_token'));
  readonly isAuthenticated = computed(() => this.token() !== null);

  private refreshInProgress$: Observable<string> | null = null;

  async login(): Promise<void> {
    const address = this.walletService.address();
    if (!address) throw new Error('Wallet not connected');

    const { challenge } = await firstValueFrom(
      this.http.post<{ challenge: string }>('/api/auth/challenge', { address }),
    );

    const signedChallenge = await this.walletService.signChallenge(challenge);

    const { accessToken } = await firstValueFrom(
      this.http.post<{ accessToken: string }>('/api/auth/verify', {
        address,
        signedChallenge,
        originalChallenge: challenge,
      }),
    );

    localStorage.setItem('nbs_token', accessToken);
    this.token.set(accessToken);
  }

  logout(): void {
    localStorage.removeItem('nbs_token');
    this.token.set(null);
    this.walletService.disconnect();
  }

  /**
   * Refreshes the current access token. Concurrent callers share a single
   * in-flight request instead of each triggering their own refresh call.
   */
  refreshToken(): Observable<string> {
    if (this.refreshInProgress$) {
      return this.refreshInProgress$;
    }

    const currentToken = this.token();
    if (!currentToken) {
      return throwError(() => new Error('No token to refresh'));
    }

    const headers = new HttpHeaders({ Authorization: `Bearer ${currentToken}` });

    this.refreshInProgress$ = this.http
      .post<{ accessToken: string }>(
        '/api/auth/refresh',
        { accessToken: currentToken },
        { headers },
      )
      .pipe(
        map((response) => response.accessToken),
        tap((accessToken) => {
          localStorage.setItem('nbs_token', accessToken);
          this.token.set(accessToken);
        }),
        shareReplay(1),
        finalize(() => {
          this.refreshInProgress$ = null;
        }),
      );

    return this.refreshInProgress$;
  }
}
