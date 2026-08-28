import { TestBed, ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { MarketplaceListComponent } from './marketplace-list.component';
import { ApiService } from '../../shared/services/api.service';
import { AuthService } from '../../auth/auth.service';
import { WalletService } from '../../auth/wallet.service';
import { Order } from '../../shared/interfaces/bond.interface';

const ORDER: Order = {
  id: 1,
  seller: 'GBOB',
  bondId: 3,
  amount: 20,
  pricePerToken: 10,
  quoteAsset: 'USDC',
  status: 'Open',
  // Fixed, far-future timestamp (2099-01-01) rather than Date.now() + N,
  // so this fixture is never accidentally expired and tests stay
  // deterministic regardless of when/how slowly CI runs them.
  expiresAt: 4070908800,
  createdAt: new Date().toISOString(),
};

describe('MarketplaceListComponent', () => {
  let component: MarketplaceListComponent;
  let fixture: ComponentFixture<MarketplaceListComponent>;
  let apiService: {
    getBonds: jasmine.Spy;
    getOrders: jasmine.Spy;
    buyBondTokens: jasmine.Spy;
    getQuoteBalance: jasmine.Spy;
  };
  let walletService: {
    isConnected: ReturnType<typeof signal<boolean>>;
    address: ReturnType<typeof signal<string | null>>;
  };

  beforeEach(async () => {
    apiService = {
      getBonds: jasmine.createSpy('getBonds').and.returnValue(of({ data: [], meta: { page: 1, limit: 100, total: 0, totalPages: 1 } })),
      getOrders: jasmine.createSpy('getOrders').and.returnValue(of({ data: [ORDER], meta:{ page: 1, limit: 20, total: 1, totalPages: 1 } })),
      buyBondTokens: jasmine.createSpy('buyBondTokens').and.returnValue(of(undefined)),
      getQuoteBalance: jasmine
        .createSpy('getQuoteBalance')
        .and.callFake((asset: string) =>
          of({ address: 'GALICE', asset, balance: asset === 'USDC' ? 100 : 0 }),
        ),
    };

    walletService = {
      isConnected: signal(true),
      address: signal('GALICE'),
    };

    await TestBed.configureTestingModule({
      imports: [MarketplaceListComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: apiService },
        { provide: AuthService, useValue: { token: signal(null) } },
        { provide: WalletService, useValue: walletService },
      ],
    }).compileComponents();
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(MarketplaceListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('loads orders and bonds on init', () => {
    expect(apiService.getOrders).toHaveBeenCalled();
    expect(apiService.getBonds).toHaveBeenCalled();
  });

  it('loads the escrowed quote balance when connected', () => {
    expect(apiService.getQuoteBalance).toHaveBeenCalledWith('USDC');
    expect(apiService.getQuoteBalance).toHaveBeenCalledWith('XLM');
  });

  it('surfaces an insufficient escrow message and disables confirm', () => {
    component.openBuy(ORDER);
    component.buyAmount = 20;
    component.buyMaxPrice = 10;
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Insufficient escrow');

    const confirm = el.querySelector<HTMLButtonElement>('.buy-actions .btn-primary');
    expect(confirm?.disabled).toBe(true);
  });

  it('allows confirm when the escrowed balance covers the purchase', () => {
    component.openBuy(ORDER);
    component.buyAmount = 5;
    component.buyMaxPrice = 10;
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Escrow sufficient');

    const confirm = el.querySelector<HTMLButtonElement>('.buy-actions .btn-primary');
    expect(confirm?.disabled).toBe(false);
  });

  it('submits a buy order', () => {
    component.openBuy(ORDER);
    component.buyAmount = 5;
    component.buyMaxPrice = 10;
    component.onBuy(ORDER);

    expect(apiService.buyBondTokens).toHaveBeenCalledWith({
      orderId: 1,
      amount: 5,
      maxPrice: 10,
    });
  });

  it('passes page and limit query params when fetching orders', () => {
    expect(apiService.getOrders).toHaveBeenCalledWith(undefined, 1, 20);
  });

  it('hides pagination controls when there is only a single page', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.pagination')).toBeNull();
    expect(el.textContent).not.toContain('Page 1 of');
  });

  it('shows pagination controls and navigates between pages', () => {
    apiService.getOrders.and.returnValues(
      of({ data: [ORDER], meta: { page: 1, limit: 20, total: 45, totalPages: 3 } }),
      of({ data: [{ ...ORDER, id: 2 }], meta: { page: 2, limit: 20, total: 45, totalPages: 3 } }),
      of({ data: [ORDER], meta: { page: 1, limit: 20, total: 45, totalPages: 3 } }),
    );
    fixture = TestBed.createComponent(MarketplaceListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(apiService.getOrders).toHaveBeenCalledWith(undefined, 1, 20);
    expect(el.textContent).toContain('Page 1 of 3');

    const prev = el.querySelector<HTMLButtonElement>('.prev-page');
    const next = el.querySelector<HTMLButtonElement>('.next-page');
    expect(prev?.disabled).toBe(true);
    expect(next?.disabled).toBe(false);

    next!.click();
    fixture.detectChanges();

    expect(apiService.getOrders).toHaveBeenCalledWith(undefined, 2, 20);
    expect(component.currentPage()).toBe(2);
    expect(component.totalPages()).toBe(3);
    expect(el.textContent).toContain('Page 2 of 3');
    expect(el.querySelector<HTMLButtonElement>('.prev-page')?.disabled).toBe(false);

    el.querySelector<HTMLButtonElement>('.prev-page')!.click();
    fixture.detectChanges();

    expect(apiService.getOrders).toHaveBeenCalledWith(undefined, 1, 20);
    expect(component.currentPage()).toBe(1);
    expect(el.textContent).toContain('Page 1 of 3');
  });

  it('disables next on the last page', () => {
    apiService.getOrders.and.returnValue(of({ data: [ORDER], meta: { page: 3, limit: 20, total: 45, totalPages: 3 } }));
    fixture = TestBed.createComponent(MarketplaceListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector<HTMLButtonElement>('.next-page')?.disabled).toBe(true);
  });

  it('resets to the first page when the bond filter changes', () => {
    apiService.getOrders.and.returnValues(
      of({ data: [ORDER], meta: { page: 1, limit: 20, total: 1, totalPages: 1 } }),
      of({ data: [ORDER], meta: { page: 1, limit: 20, total: 1, totalPages: 1 } }),
    );
    fixture = TestBed.createComponent(MarketplaceListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    component.onFilterChange(3);
    fixture.detectChanges();

    expect(apiService.getOrders).toHaveBeenCalledWith(3, 1, 20);
    expect(component.currentPage()).toBe(1);
  });
});
