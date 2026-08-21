import { TestBed, ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { provideRouter } from '@angular/router';
import { DashboardComponent } from './dashboard.component';
import { ApiService } from '../shared/services/api.service';
import { WalletService } from '../auth/wallet.service';
import { Bond, Project } from '../shared/interfaces/bond.interface';

const HOLDER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('DashboardComponent', () => {
  let fixture: ComponentFixture<DashboardComponent>;
  let apiService: {
    getBonds: jasmine.Spy;
    getProjects: jasmine.Spy;
    getAccruedCredits: jasmine.Spy;
  };
  let walletService: { address: ReturnType<typeof signal<string | null>> };

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
      maturityStatus: 'Active',
      totalSupply: 2000,
      totalSubscribed: 1000,
      status: 'Active',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  const projects: Project[] = [
    {
      id: 1,
      name: 'Forest',
      status: 'Approved',
      methodology: 'VERRA',
      country: 'KE',
      metadataIpfsHash: 'ipfs',
      ownerAddress: 'owner',
      totalAreaHa: 10,
      carbonSequestrationEstimate: 50,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  const statValue = (label: string): string | undefined => {
    const cards = Array.from(
      fixture.nativeElement.querySelectorAll(
        '.stat-card',
      ) as NodeListOf<HTMLElement>,
    );
    const card = cards.find(
      (c) => c.querySelector('.stat-label')?.textContent?.trim() === label,
    );
    return card?.querySelector('.stat-value')?.textContent?.trim();
  };

  beforeEach(async () => {
    apiService = {
      getBonds: jasmine
        .createSpy('getBonds')
        .and.returnValue(
          of({ data: bonds, meta: { page: 1, limit: 5, total: 2, totalPages: 1 } }),
        ),
      getProjects: jasmine
        .createSpy('getProjects')
        .and.returnValue(
          of({ data: projects, meta: { page: 1, limit: 5, total: 1, totalPages: 1 } }),
        ),
      getAccruedCredits: jasmine
        .createSpy('getAccruedCredits')
        .and.returnValue(
          of({ bondId: 1, holder: HOLDER, total: 0, perCreditType: [] }),
        ),
    };
    walletService = { address: signal<string | null>(null) };

    await TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: apiService },
        { provide: WalletService, useValue: walletService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardComponent);
  });

  afterEach(() => {
    fixture?.destroy();
  });

  it('queries accrued credits for each bond when a wallet is connected', () => {
    walletService.address.set(HOLDER);
    fixture.detectChanges();

    expect(apiService.getAccruedCredits).toHaveBeenCalledTimes(2);
    expect(apiService.getAccruedCredits).toHaveBeenCalledWith(1, HOLDER);
    expect(apiService.getAccruedCredits).toHaveBeenCalledWith(2, HOLDER);
  });

  it('does not query accrued credits without a connected wallet', () => {
    fixture.detectChanges();

    expect(apiService.getAccruedCredits).not.toHaveBeenCalled();
  });

  it('renders accrued carbon and biodiversity credit totals', () => {
    walletService.address.set(HOLDER);
    apiService.getAccruedCredits.and.callFake((id: number) =>
      of(
        id === 1
          ? {
              bondId: 1,
              holder: HOLDER,
              total: 150,
              perCreditType: [
                { creditType: 'Carbon', amount: 120 },
                { creditType: 'Biodiversity', amount: 30 },
              ],
            }
          : {
              bondId: 2,
              holder: HOLDER,
              total: 15,
              perCreditType: [
                { creditType: 'Carbon', amount: 10 },
                { creditType: 'Biodiversity', amount: 5 },
              ],
            },
      ),
    );
    fixture.detectChanges();

    expect(statValue('Accrued Carbon Credits')).toBe('130');
    expect(statValue('Accrued Biodiversity Credits')).toBe('35');
  });

  it('handles an accrued credits API error without crashing', () => {
    walletService.address.set(HOLDER);
    apiService.getAccruedCredits.and.returnValue(
      throwError(() => new Error('upstream failure')),
    );
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Failed to load accrued credits',
    );
    // The rest of the dashboard still renders.
    expect(fixture.nativeElement.textContent).toContain('Total Bonds');
  });
});
