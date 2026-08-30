import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { BondsListComponent } from './bonds-list.component';
import { ApiService } from '../../shared/services/api.service';
import { Bond } from '../../shared/interfaces/bond.interface';

describe('BondsListComponent', () => {
  let fixture: ComponentFixture<BondsListComponent>;
  let component: BondsListComponent;
  let apiService: jasmine.SpyObj<ApiService>;
  let router: Router;

  const bonds: Bond[] = [
    {
      id: 1,
      projectId: 'p1',
      faceValue: 1000,
      couponSchedule: [1000000],
      creditType: 'Carbon',
      maturityDate: 3000000,
      maturityStatus: 'Active',
      totalSupply: 1000,
      totalSubscribed: 500,
      status: 'Active',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 2,
      projectId: 'p2',
      faceValue: 2000,
      couponSchedule: [1000000],
      creditType: 'Biodiversity',
      maturityDate: 3000000,
      maturityStatus: 'Matured',
      totalSupply: 2000,
      totalSubscribed: 1000,
      status: 'Matured',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  const paginated = (data: Bond[] = bonds) => ({
    data,
    meta: { page: 1, limit: 12, total: data.length, totalPages: 1 },
  });

  beforeEach(async () => {
    apiService = jasmine.createSpyObj('ApiService', ['getBonds']);
    apiService.getBonds.and.returnValue(of(paginated()));

    await TestBed.configureTestingModule({
      imports: [BondsListComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: apiService },
      ],
    }).compileComponents();

    router = TestBed.inject(Router);
    spyOn(router, 'navigate');
    fixture = TestBed.createComponent(BondsListComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    fixture?.destroy();
  });

  it('creates and renders without errors', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.bonds-page')).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('app-bond-card').length).toBe(2);
  });

  it('loads bonds from the API on init with the default page and limit', () => {
    fixture.detectChanges();
    expect(apiService.getBonds).toHaveBeenCalledOnceWith(1, 12);
    expect(component.bonds().length).toBe(2);
    expect(component.loading()).toBe(false);
  });

  it('filters bonds by status', () => {
    fixture.detectChanges();
    component.filter.set('Active');
    fixture.detectChanges();
    expect(component.filteredBonds().map((b) => b.id)).toEqual([1]);

    component.filter.set('Matured');
    fixture.detectChanges();
    expect(component.filteredBonds().map((b) => b.id)).toEqual([2]);

    component.filter.set('all');
    fixture.detectChanges();
    expect(component.filteredBonds().length).toBe(2);
  });

  it('renders an empty-state message when no bonds match the filter', () => {
    apiService.getBonds.and.returnValue(
      of(paginated([])),
    );
    fixture = TestBed.createComponent(BondsListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.empty-section')).not.toBeNull();
  });

  it('advances to the next page and reloads bonds', () => {
    fixture.detectChanges();
    apiService.getBonds.and.returnValue(
      of(paginated(bonds.map((b) => ({ ...b, id: b.id + 2 })))),
    );
    component.totalPages.set(3);

    component.nextPage();
    expect(component.page()).toBe(2);
    expect(apiService.getBonds).toHaveBeenCalledWith(2, 12);
  });

  it('does not advance past the last page', () => {
    component.totalPages.set(1);
    fixture.detectChanges();
    component.nextPage();
    expect(component.page()).toBe(1);
    expect(apiService.getBonds).toHaveBeenCalledTimes(1);
  });

  it('goes back to the previous page', () => {
    component.totalPages.set(3);
    component.page.set(2);
    fixture.detectChanges();

    component.prevPage();
    expect(component.page()).toBe(1);
    expect(apiService.getBonds).toHaveBeenCalledWith(1, 12);
  });

  it('does not go before the first page', () => {
    component.page.set(1);
    fixture.detectChanges();
    component.prevPage();
    expect(component.page()).toBe(1);
    expect(apiService.getBonds).toHaveBeenCalledTimes(1);
  });

  it('navigates to the bond detail on subscribe', () => {
    fixture.detectChanges();
    component.onSubscribe(7);
    expect(router.navigate).toHaveBeenCalledWith(['/bonds', 7]);
  });

  it('surfaces an error when the bond load fails', () => {
    apiService.getBonds.and.returnValue(
      throwError(() => new Error('boom')),
    );
    fixture = TestBed.createComponent(BondsListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    expect(component.loading()).toBe(false);
    expect(component.error()).toBe('Failed to load bonds');
    expect(fixture.nativeElement.querySelector('.error-banner')).not.toBeNull();
  });
});
