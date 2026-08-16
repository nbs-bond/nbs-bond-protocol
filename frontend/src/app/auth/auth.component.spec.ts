import { TestBed, ComponentFixture } from '@angular/core/testing';
import { signal, computed } from '@angular/core';
import { provideRouter } from '@angular/router';
import { AuthComponent } from './auth.component';
import { AuthService } from './auth.service';
import { WalletService, WalletError } from './wallet.service';
import { BROWSER_WINDOW, FreighterWindow } from './freighter.tokens';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0';

describe('AuthComponent', () => {
  let fixture: ComponentFixture<AuthComponent>;
  let walletError: ReturnType<typeof signal<WalletError | null>>;
  let walletService: {
    address: ReturnType<typeof signal<string | null>>;
    isConnected: ReturnType<typeof signal<boolean>>;
    isConnecting: ReturnType<typeof signal<boolean>>;
    error: typeof walletError;
    needsInstall: ReturnType<typeof computed<boolean>>;
    connect: jasmine.Spy;
  };
  let authService: { login: jasmine.Spy };

  // `window.freighter` is left unset at the harness level so the component tree
  // sees exactly what a browser without the extension would expose.
  function configure(userAgent = CHROME_UA): void {
    walletError = signal<WalletError | null>(null);
    walletService = {
      address: signal<string | null>(null),
      isConnected: signal(false),
      isConnecting: signal(false),
      error: walletError,
      needsInstall: computed(() => walletError()?.kind === 'not-installed'),
      connect: jasmine.createSpy('connect').and.resolveTo(false),
    };
    authService = { login: jasmine.createSpy('login').and.resolveTo(undefined) };

    TestBed.configureTestingModule({
      imports: [AuthComponent],
      providers: [
        provideRouter([]),
        { provide: WalletService, useValue: walletService },
        { provide: AuthService, useValue: authService },
        {
          provide: BROWSER_WINDOW,
          useValue: { navigator: { userAgent } } as unknown as FreighterWindow,
        },
      ],
    });

    fixture = TestBed.createComponent(AuthComponent);
    fixture.detectChanges();
  }

  function query(selector: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(selector);
  }

  it('creates the component', () => {
    configure();
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('shows no install prompt while the wallet is healthy', () => {
    configure();
    expect(query('app-freighter-install-prompt')).toBeNull();
  });

  it('connects through the component so failures cannot go unhandled', async () => {
    configure();
    (query('.btn-primary') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(walletService.connect).toHaveBeenCalled();
  });

  describe('when Freighter is not installed', () => {
    it('shows an install prompt instead of a blank error', () => {
      configure();
      walletError.set(new WalletError('not-installed', 'Freighter wallet extension not detected.'));
      fixture.detectChanges();

      const prompt = query('app-freighter-install-prompt');
      expect(prompt).not.toBeNull();
      expect(prompt?.textContent).toContain('Freighter wallet not found');
      // The install prompt carries the message, so no duplicate error line.
      expect(query('.error')).toBeNull();
    });

    it('links to the Chrome Web Store on Chrome', () => {
      configure(CHROME_UA);
      walletError.set(new WalletError('not-installed', 'not detected'));
      fixture.detectChanges();

      const link = query('app-freighter-install-prompt a') as HTMLAnchorElement;
      expect(link.href).toContain('chromewebstore.google.com');
      expect(link.textContent).toContain('Chrome Web Store');
    });

    it('links to Firefox Add-ons on Firefox', () => {
      configure(FIREFOX_UA);
      walletError.set(new WalletError('not-installed', 'not detected'));
      fixture.detectChanges();

      const link = query('app-freighter-install-prompt a') as HTMLAnchorElement;
      expect(link.href).toContain('addons.mozilla.org');
      expect(link.textContent).toContain('Firefox Add-ons');
    });

    it('retries the connection from the prompt', async () => {
      configure();
      walletError.set(new WalletError('not-installed', 'not detected'));
      fixture.detectChanges();

      (query('app-freighter-install-prompt .btn-link') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(walletService.connect).toHaveBeenCalled();
    });
  });

  it('shows a rejected prompt as an error message, not an install prompt', () => {
    configure();
    walletError.set(new WalletError('rejected', 'You declined the Freighter request.'));
    fixture.detectChanges();

    expect(query('app-freighter-install-prompt')).toBeNull();
    expect(query('.error')?.textContent).toContain('You declined the Freighter request.');
  });

  it('surfaces sign-in failures', async () => {
    configure();
    walletService.isConnected.set(true);
    walletService.address.set('GABC');
    authService.login.and.rejectWith(new Error('challenge expired'));
    fixture.detectChanges();

    await fixture.componentInstance.signIn();
    fixture.detectChanges();

    expect(query('.error')?.textContent).toContain('challenge expired');
  });
});
