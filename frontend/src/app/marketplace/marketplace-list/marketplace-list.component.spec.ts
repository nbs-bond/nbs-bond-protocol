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
    expect(apiService.getOrders).toHaveBeenCalledWith({
      bondId: undefined,
      page: 1,
      limit: 20,
    });
    expect(apiService.getBonds).toHaveBeenCalled();
  });

  it('navigates between order pages', () => {
    apiService.getOrders.and.returnValues(
      of({ data: [ORDER], meta: { page: 2, limit: 20, total: 45, totalPages: 3 } }),
      of({ data: [ORDER], meta: { page: 1, limit: 20, total: 45, totalPages: 3 } }),
    );
    component.totalPages.set(3);

    component.nextPage();

    expect(apiService.getOrders).toHaveBeenCalledWith({ bondId: undefined, page: 2, limit: 20 });
    expect(component.currentPage()).toBe(2);

    component.previousPage();

    expect(apiService.getOrders).toHaveBeenCalledWith({ bondId: undefined, page: 1, limit: 20 });
    expect(component.currentPage()).toBe(1);
  });

  it('does not navigate past the available page range', () => {
    apiService.getOrders.calls.reset();

    component.previousPage();
    expect(apiService.getOrders).not.toHaveBeenCalled();

    component.currentPage.set(3);
    component.totalPages.set(3);
    component.nextPage();
    expect(apiService.getOrders).not.toHaveBeenCalled();
  });

  it('shows pagination controls when more than one page is available', () => {
    component.totalPages.set(3);
    fixture.detectChanges();

    const pagination: HTMLElement | null = fixture.nativeElement.querySelector('.pagination');
    expect(pagination?.textContent).toContain('Previous');
    expect(pagination?.textContent).toContain('Page 1 of 3');
    expect(pagination?.textContent).toContain('Next');
  });

  it('uses hasMore when the API cannot provide an exact page count', () => {
    apiService.getOrders.and.returnValue(
      of({ data: [ORDER], meta: { page: 1, limit: 20, total: 20, totalPages: 1, hasMore: true } }),
    );

    component.onFilterChange(null);

    expect(component.totalPages()).toBe(2);
  });

  it('resets pagination and preserves the bond filter when it changes', () => {
    component.currentPage.set(2);

    component.onFilterChange(3);

    expect(apiService.getOrders).toHaveBeenCalledWith({ bondId: 3, page: 1, limit: 20 });
    expect(component.currentPage()).toBe(1);
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
});
