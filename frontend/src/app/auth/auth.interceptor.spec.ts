import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';
import { WalletService } from './wallet.service';

describe('authInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let authService: AuthService;
  let router: Router;

  beforeEach(() => {
    localStorage.setItem('nbs_token', 'expired-token');

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: WalletService, useValue: { disconnect: () => {} } },
      ],
    });

    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
    authService = TestBed.inject(AuthService);
    router = TestBed.inject(Router);
    spyOn(router, 'navigate').and.resolveTo(true);
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.removeItem('nbs_token');
  });

  it('refreshes the token on a 401 and retries the original request', () => {
    let result: unknown;
    http.get('/api/bonds').subscribe((res) => (result = res));

    httpMock.expectOne('/api/bonds').flush('unauthorized', { status: 401, statusText: 'Unauthorized' });

    const refresh = httpMock.expectOne('/api/auth/refresh');
    expect(refresh.request.headers.get('Authorization')).toBe('Bearer expired-token');
    refresh.flush({ accessToken: 'new-token' });

    const retry = httpMock.expectOne('/api/bonds');
    expect(retry.request.headers.get('Authorization')).toBe('Bearer new-token');
    retry.flush({ ok: true });

    expect(result).toEqual({ ok: true });
    expect(authService.token()).toBe('new-token');
  });

  it('queues concurrent requests behind a single refresh call', () => {
    const results: unknown[] = [];
    http.get('/api/bonds').subscribe((res) => results.push(res));
    http.get('/api/projects').subscribe((res) => results.push(res));

    httpMock.expectOne('/api/bonds').flush('unauthorized', { status: 401, statusText: 'Unauthorized' });
    httpMock.expectOne('/api/projects').flush('unauthorized', { status: 401, statusText: 'Unauthorized' });

    // Both 401s must share a single in-flight refresh call.
    httpMock.expectOne('/api/auth/refresh').flush({ accessToken: 'new-token' });

    httpMock.expectOne('/api/bonds').flush({ a: 1 });
    httpMock.expectOne('/api/projects').flush({ b: 2 });

    expect(results).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('does not intercept its own refresh request', () => {
    let errored = false;
    authService.refreshToken().subscribe({ error: () => (errored = true) });

    httpMock
      .expectOne('/api/auth/refresh')
      .flush('unauthorized', { status: 401, statusText: 'Unauthorized' });

    expect(errored).toBeTrue();
  });

  it('logs out and redirects to /auth when refresh fails', () => {
    let error: unknown;
    http.get('/api/bonds').subscribe({ error: (err) => (error = err) });

    httpMock.expectOne('/api/bonds').flush('unauthorized', { status: 401, statusText: 'Unauthorized' });
    httpMock
      .expectOne('/api/auth/refresh')
      .flush('unauthorized', { status: 401, statusText: 'Unauthorized' });

    expect(error).toBeTruthy();
    expect(authService.token()).toBeNull();
    expect(router.navigate).toHaveBeenCalledWith(['/auth']);
  });
});
