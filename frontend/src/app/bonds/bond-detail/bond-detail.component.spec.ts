import { ComponentFixture, TestBed, fakeAsync, tick, discardPeriodicTasks } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { BondDetailComponent } from './bond-detail.component';
import { ApiService } from '../../shared/services/api.service';
import { WalletService } from '../../auth/wallet.service';
import { Bond } from '../../shared/interfaces/bond.interface';
import { environment } from '../../../environments/environment';

describe('BondDetailComponent', () => {
  let fixture: ComponentFixture<BondDetailComponent>;
  let apiService: jasmine.SpyObj<ApiService>;
  let walletService: WalletService;

  const bond = {
    id: 1,
    projectId: 'a1b2',
    faceValue: 1000,
    couponSchedule: [1000000, 2000000],
    creditType: 'Carbon' as const,
    maturityDate: 3000000,
    maturityStatus: 'Active' as const,
    totalSupply: 10000,
    totalSubscribed: 5000,
    status: 'Active' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const futureBond = (
    overrides: Partial<Pick<Bond, 'maturityDate' | 'maturityStatus'>> = {},
  ): Bond => ({
    ...bond,
    maturityDate: Math.floor(Date.now() / 1000) + 3 * 86400,
    maturityStatus: 'Active',
    ...overrides,
  });

  beforeEach(async () => {
    apiService = jasmine.createSpyObj('ApiService', [
      'getBond', 'subscribeToBond', 'claimCredits', 'transferBond',
      'getUndistributedTotal', 'sweepUndistributed', 'getAccruedCredits',
    ]);
    apiService.getBond.and.returnValue(of(bond));
    apiService.getUndistributedTotal.and.returnValue(
      of({ bondId: 1, undistributedTotal: 7 }),
    );
    apiService.sweepUndistributed.and.returnValue(
      of({
        bondId: 1,
        destination: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        amount: 7,
        carbonAmount: 7,
        biodiversityAmount: 0,
        swept: 7,
        transactionHash: '0xabc',
      }),
    );
    apiService.getAccruedCredits.and.returnValue(
      of({
        bondId: 1,
        holder: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        total: 150,
        perCreditType: [
          { creditType: 'Carbon', amount: 100 },
          { creditType: 'Biodiversity', amount: 50 },
        ],
      }),
    );

    await TestBed.configureTestingModule({
      imports: [BondDetailComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: { get: () => '1' } } },
        },
        { provide: ApiService, useValue: apiService },
        WalletService,
      ],
    }).compileComponents();

    walletService = TestBed.inject(WalletService);
  });

  afterEach(() => {
    fixture?.destroy();
  });

  const createFixture = (): void => {
    fixture = TestBed.createComponent(BondDetailComponent);
    fixture.detectChanges();
    tick();
    fixture.detectChanges();
    tick();
    fixture.detectChanges();
  };

  const adminSection = (): HTMLElement | null =>
    fixture.nativeElement.querySelector('.admin-section');

  it('shows the undistributed total to the admin wallet', fakeAsync(() => {
    walletService.address.set(environment.adminAddress);
    createFixture();

    expect(apiService.getUndistributedTotal).toHaveBeenCalledWith(1);
    const section = adminSection();
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('7');
    expect(section?.textContent).toContain('Sweep Undistributed');
    discardPeriodicTasks();
  }));

  it('hides the admin panel from non-admin wallets', fakeAsync(() => {
    walletService.address.set(
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    );
    createFixture();

    expect(apiService.getUndistributedTotal).not.toHaveBeenCalled();
    expect(adminSection()).toBeNull();
    discardPeriodicTasks();
  }));

  it('sweeps undistributed credits only after confirmation', fakeAsync(() => {
    walletService.address.set(environment.adminAddress);
    createFixture();

    const confirmSpy = spyOn(window, 'confirm').and.returnValue(true);
    const sweepBtn = fixture.nativeElement.querySelector(
      '.sweep-btn',
    ) as HTMLButtonElement;
    expect(sweepBtn).not.toBeNull();
    sweepBtn.click();
    tick();
    fixture.detectChanges();

    expect(confirmSpy).toHaveBeenCalled();
    expect(apiService.sweepUndistributed).toHaveBeenCalledWith(1);
    expect(fixture.nativeElement.textContent).toContain('0xabc');
    discardPeriodicTasks();
  }));

  it('does not sweep when confirmation is declined', fakeAsync(() => {
    walletService.address.set(environment.adminAddress);
    createFixture();

    spyOn(window, 'confirm').and.returnValue(false);
    const sweepBtn = fixture.nativeElement.querySelector(
      '.sweep-btn',
    ) as HTMLButtonElement;
    sweepBtn.click();

    expect(apiService.sweepUndistributed).not.toHaveBeenCalled();
    discardPeriodicTasks();
  }));

  it('shows a live countdown for a bond that has not reached maturity', fakeAsync(() => {
    apiService.getBond.and.returnValue(of(futureBond()));
    createFixture();

    const banner = fixture.nativeElement.querySelector(
      '.maturity-banner',
    ) as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('Matures in');
    expect(banner.textContent).toContain('d');
    discardPeriodicTasks();
  }));

  it('shows the frozen-for-trading state and hides subscribe/transfer after maturity', fakeAsync(() => {
    apiService.getBond.and.returnValue(
      of(futureBond({ maturityStatus: 'Matured' })),
    );
    createFixture();

    const banner = fixture.nativeElement.querySelector(
      '.maturity-banner.frozen',
    ) as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('Frozen for trading');

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('frozen for trading');
    expect(text).toContain('Transfers are disabled');
    expect(fixture.nativeElement.querySelector('.subscribe-btn')).toBeNull();
    expect(fixture.nativeElement.querySelector('.transfer-btn')).toBeNull();
    discardPeriodicTasks();
  }));

  it('disables subscribe/transfer once the maturity date has elapsed, even when status is still Active', fakeAsync(() => {
    apiService.getBond.and.returnValue(
      of(futureBond({ maturityDate: Math.floor(Date.now() / 1000) - 10 })),
    );
    createFixture();

    expect(fixture.nativeElement.textContent).toContain('frozen for trading');
    expect(fixture.nativeElement.querySelector('.subscribe-btn')).toBeNull();
    expect(fixture.nativeElement.querySelector('.transfer-btn')).toBeNull();
    discardPeriodicTasks();
  }));

  it('formats the countdown in days, hours, minutes and seconds', () => {
    const component = TestBed.createComponent(BondDetailComponent).componentInstance;
    expect(component.formatCountdown(2 * 86400000 + 3 * 3600000 + 4 * 60000 + 5000)).toBe(
      '2d 3h 4m 5s',
    );
    expect(component.formatCountdown(5 * 1000)).toBe('5s');
    expect(component.formatCountdown(0)).toBe('');
  });

  it('loads accrued credits for the connected wallet and renders the claimable amount', fakeAsync(() => {
    const holder = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    walletService.address.set(holder);
    createFixture();

    expect(apiService.getAccruedCredits).toHaveBeenCalledWith(1, holder);
    const claimSection = fixture.nativeElement.querySelector('.claim-section');
    expect(claimSection?.textContent).toContain('150');
    expect(claimSection?.textContent).toContain('Carbon: 100');
    expect(claimSection?.textContent).toContain('Biodiversity: 50');
    const claimBtn = claimSection?.querySelector('.claim-btn') as HTMLButtonElement;
    expect(claimBtn.disabled).toBe(false);
    expect(claimBtn.textContent).toContain('Claim 150 Accrued Credits');
    discardPeriodicTasks();
  }));

  it('disables the claim button when nothing has accrued', fakeAsync(() => {
    walletService.address.set(
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    );
    apiService.getAccruedCredits.and.returnValue(
      of({
        bondId: 1,
        holder: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        total: 0,
        perCreditType: [],
      }),
    );
    createFixture();

    const claimSection = fixture.nativeElement.querySelector('.claim-section');
    expect(claimSection?.textContent).toContain('Accrued credits:');
    const claimBtn = claimSection?.querySelector('.claim-btn') as HTMLButtonElement;
    expect(claimBtn.disabled).toBe(true);
    expect(claimSection?.textContent).toContain('No credits accrued yet');
    discardPeriodicTasks();
  }));
});
