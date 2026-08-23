import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { WalletService, WalletError } from './wallet.service';
import { BROWSER_WINDOW, FREIGHTER_API, FreighterWindow } from './freighter.tokens';
import { environment } from '../../environments/environment';

const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const DECLINED = { code: -4, message: 'User declined access' };
const INTERNAL = { code: -1, message: 'The wallet encountered an internal error.' };

describe('WalletService', () => {
  let freighter: {
    isConnected: jasmine.Spy;
    getAddress: jasmine.Spy;
    signTransaction: jasmine.Spy;
  };
  // The absent-extension case is simulated at the harness level: `window.freighter`
  // is left unset and the Freighter API is provided as a stub through TestBed.
  let win: FreighterWindow;
  let service: WalletService;

  beforeEach(() => {
    freighter = {
      isConnected: jasmine.createSpy('isConnected').and.resolveTo({ isConnected: false }),
      getAddress: jasmine.createSpy('getAddress').and.resolveTo({ address: ADDRESS }),
      signTransaction: jasmine
        .createSpy('signTransaction')
        .and.resolveTo({ signedTxXdr: 'signed-xdr', signerAddress: ADDRESS }),
    };
    win = {
      freighter: undefined,
      setTimeout: (handler: TimerHandler, timeout?: number) => setTimeout(handler, timeout),
      navigator: { userAgent: 'test' },
    } as unknown as FreighterWindow;

    TestBed.configureTestingModule({
      providers: [
        { provide: FREIGHTER_API, useValue: freighter },
        { provide: BROWSER_WINDOW, useValue: win },
      ],
    });
    service = TestBed.inject(WalletService);
  });

  describe('when Freighter is not installed', () => {
    it('reports a not-installed error instead of rejecting', fakeAsync(() => {
      let connected: boolean | undefined;
      service.connect().then(result => (connected = result));
      tick(2000);

      expect(connected).toBe(false);
      expect(service.error()?.kind).toBe('not-installed');
      expect(service.needsInstall()).toBe(true);
      expect(service.isConnected()).toBe(false);
      expect(service.isConnecting()).toBe(false);
      expect(freighter.getAddress).not.toHaveBeenCalled();
    }));

    it('survives an API call that throws because window.freighter is undefined', fakeAsync(() => {
      freighter.isConnected.and.throwError(
        new TypeError("Cannot read properties of undefined (reading 'isConnected')"),
      );

      let connected: boolean | undefined;
      service.connect().then(result => (connected = result));
      tick(2000);

      expect(connected).toBe(false);
      expect(service.needsInstall()).toBe(true);
    }));

    it('polls before giving up rather than deciding on the first check', fakeAsync(() => {
      let settled = false;
      service.connect().then(() => (settled = true));

      // A synchronous verdict here would fire the install prompt at users who do
      // have Freighter but whose content script has not run yet.
      tick(300);
      expect(settled).toBe(false);
      expect(freighter.isConnected).not.toHaveBeenCalled();

      // The API probe is the last resort, reached only once polling found nothing.
      tick(2000);
      expect(settled).toBe(true);
      expect(freighter.isConnected).toHaveBeenCalledTimes(1);
    }));
  });

  describe('when Freighter is injected late', () => {
    it('connects once window.freighter appears during the polling window', fakeAsync(() => {
      let connected: boolean | undefined;
      service.connect().then(result => (connected = result));

      // The content script has not run yet at this point.
      tick(200);
      expect(service.isConnecting()).toBe(true);
      win.freighter = true;

      tick(2000);
      expect(connected).toBe(true);
      expect(service.address()).toBe(ADDRESS);
      expect(service.isConnected()).toBe(true);
      expect(service.error()).toBeNull();
      // Polling found the flag, so the slower API probe was never needed.
      expect(freighter.isConnected).not.toHaveBeenCalled();
    }));

    it('connects immediately when the extension is already present', fakeAsync(() => {
      win.freighter = true;

      service.connect();
      tick();

      expect(service.isConnected()).toBe(true);
      expect(freighter.getAddress).toHaveBeenCalledTimes(1);
    }));
  });

  describe('when the user rejects a prompt', () => {
    beforeEach(() => {
      win.freighter = true;
    });

    it('distinguishes a declined connection from a missing extension', fakeAsync(() => {
      freighter.getAddress.and.resolveTo({ address: '', error: DECLINED });

      service.connect();
      tick();

      expect(service.error()?.kind).toBe('rejected');
      expect(service.needsInstall()).toBe(false);
      expect(service.isConnected()).toBe(false);
    }));

    it('treats an empty address with no error as a declined connection', fakeAsync(() => {
      freighter.getAddress.and.resolveTo({ address: '' });

      service.connect();
      tick();

      expect(service.error()?.kind).toBe('rejected');
      expect(service.address()).toBeNull();
    }));

    it('reports a declined signature as rejected', fakeAsync(() => {
      freighter.signTransaction.and.resolveTo({
        signedTxXdr: '',
        signerAddress: '',
        error: DECLINED,
      });

      let caught: WalletError | undefined;
      service.signChallenge('challenge-xdr').catch((e: WalletError) => (caught = e));
      tick();

      expect(caught).toBeInstanceOf(WalletError);
      expect(caught?.kind).toBe('rejected');
      expect(service.error()?.kind).toBe('rejected');
    }));
  });

  describe('when Freighter fails for other reasons', () => {
    beforeEach(() => {
      win.freighter = true;
    });

    it('reports an internal wallet error as unavailable', fakeAsync(() => {
      freighter.getAddress.and.resolveTo({ address: '', error: INTERNAL });

      service.connect();
      tick();

      expect(service.error()?.kind).toBe('unavailable');
      expect(service.error()?.message).toBe(INTERNAL.message);
      expect(service.needsInstall()).toBe(false);
    }));

    it('reports a signing call that throws as unavailable', fakeAsync(() => {
      freighter.signTransaction.and.rejectWith(new Error('extension port closed'));

      let caught: WalletError | undefined;
      service.signChallenge('challenge-xdr').catch((e: WalletError) => (caught = e));
      tick();

      expect(caught?.kind).toBe('unavailable');
    }));
  });

  it('returns the signed XDR when signing succeeds', fakeAsync(() => {
    win.freighter = true;

    let signed: string | undefined;
    service.signChallenge('challenge-xdr').then(result => (signed = result));
    tick();

    expect(signed).toBe('signed-xdr');
    expect(service.error()).toBeNull();
  }));

  it('signs with the passphrase from the environment config', fakeAsync(() => {
    win.freighter = true;

    service.signChallenge('challenge-xdr').catch(() => {});
    tick();

    expect(freighter.signTransaction).toHaveBeenCalledWith('challenge-xdr', {
      networkPassphrase: environment.networkPassphrase,
    });
  }));

  it('clears wallet state and errors on disconnect', fakeAsync(() => {
    service.connect();
    tick(2000);
    expect(service.error()).not.toBeNull();

    service.disconnect();

    expect(service.address()).toBeNull();
    expect(service.isConnected()).toBe(false);
    expect(service.error()).toBeNull();
  }));
});
