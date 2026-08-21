import { Component, inject, OnInit, ChangeDetectionStrategy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { ApiService } from '../shared/services/api.service';
import { WalletService } from '../auth/wallet.service';
import { BondCardComponent } from '../shared/components/bond-card/bond-card.component';
import { ProjectCardComponent } from '../shared/components/project-card/project-card.component';
import { LoadingSpinnerComponent } from '../shared/components/loading-spinner/loading-spinner.component';
import { Bond, Project, AccruedCreditsResponse } from '../shared/interfaces/bond.interface';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule, BondCardComponent, ProjectCardComponent, LoadingSpinnerComponent],
  template: `
    <div class="dashboard">
      <h1 class="page-title">Dashboard</h1>

      @if (error()) {
        <div class="error-banner">{{ error() }}</div>
      }

      @if (accruedError()) {
        <div class="error-banner">{{ accruedError() }}</div>
      }

      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-label">Total Bonds</span>
          <span class="stat-value">{{ totalBonds() }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Active Bonds</span>
          <span class="stat-value">{{ activeBonds() }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Total Projects</span>
          <span class="stat-value">{{ totalProjects() }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Carbon Sequestration</span>
          <span class="stat-value">{{ carbonTotal() | number }} tCO₂e</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Accrued Carbon Credits</span>
          <span class="stat-value">{{ accruedCarbon() | number }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Accrued Biodiversity Credits</span>
          <span class="stat-value">{{ accruedBiodiversity() | number }}</span>
        </div>
      </div>

      @if (loading()) {
        <div class="loading-section">
          <app-loading-spinner size="lg" />
        </div>
      } @else if (bonds().length === 0 && projects().length === 0) {
        <div class="empty-section">
          <p>No bonds or projects yet.</p>
          <div class="quick-actions">
            <a class="btn btn-primary" routerLink="/projects/new">Register a Project</a>
            <a class="btn btn-secondary" routerLink="/bonds">View Bonds</a>
          </div>
        </div>
      } @else {
        <section class="section">
          <div class="section-header">
            <h2>Recent Bonds</h2>
            <a class="section-link" routerLink="/bonds">View All</a>
          </div>
          @if (bonds().length > 0) {
            <div class="card-grid">
              @for (bond of bonds(); track bond.id) {
                <app-bond-card
                  [bond]="bond"
                  [accruedCredits]="accruedCredits()[bond.id]"
                  (subscribe)="onSubscribe($event)"
                />
              }
            </div>
          } @else {
            <p class="section-empty">No bonds found.</p>
          }
        </section>

        <section class="section">
          <div class="section-header">
            <h2>Recent Projects</h2>
            <a class="section-link" routerLink="/projects">View All</a>
          </div>
          @if (projects().length > 0) {
            <div class="card-grid">
              @for (project of projects(); track project.id) {
                <app-project-card [project]="project" />
              }
            </div>
          } @else {
            <p class="section-empty">No projects found.</p>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    .dashboard { max-width: 1200px; }
    .page-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 24px; }
    .error-banner { background: #fef2f2; color: #ef4444; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.875rem; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat-card { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .stat-label { display: block; font-size: 0.75rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .stat-value { display: block; font-size: 1.75rem; font-weight: 700; color: #1a1a2e; }
    .loading-section { display: flex; justify-content: center; padding: 48px 0; }
    .empty-section { text-align: center; padding: 48px 0; color: #6b7280; }
    .quick-actions { display: flex; gap: 12px; justify-content: center; margin-top: 16px; }
    .section { margin-bottom: 32px; }
    .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .section-header h2 { font-size: 1.125rem; font-weight: 600; }
    .section-link { font-size: 0.875rem; color: #3b82f6; text-decoration: none; }
    .section-link:hover { text-decoration: underline; }
    .section-empty { color: #6b7280; font-size: 0.875rem; padding: 16px 0; }
    .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
    .btn { display: inline-block; padding: 10px 20px; border-radius: 8px; font-size: 0.875rem; font-weight: 500; text-decoration: none; cursor: pointer; border: none; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-primary:hover { background: #2a2a4e; }
    .btn-secondary { background: #fff; color: #1a1a2e; border: 1px solid #d1d5db; }
    .btn-secondary:hover { background: #f0f2f5; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardComponent implements OnInit {
  private readonly apiService = inject(ApiService);
  private readonly walletService = inject(WalletService);
  private readonly router = inject(Router);

  readonly bonds = signal<Bond[]>([]);
  readonly projects = signal<Project[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly accruedCredits = signal<Record<number, AccruedCreditsResponse>>({});
  readonly accruedError = signal('');

  readonly totalBonds = signal(0);
  readonly activeBonds = signal(0);
  readonly totalProjects = signal(0);
  readonly carbonTotal = signal(0);

  readonly accruedCarbon = computed(() =>
    Object.values(this.accruedCredits()).reduce(
      (sum, acc) =>
        sum +
        (acc.perCreditType.find((e) => e.creditType === 'Carbon')?.amount ?? 0),
      0,
    ),
  );
  readonly accruedBiodiversity = computed(() =>
    Object.values(this.accruedCredits()).reduce(
      (sum, acc) =>
        sum +
        (acc.perCreditType.find((e) => e.creditType === 'Biodiversity')?.amount ?? 0),
      0,
    ),
  );

  ngOnInit(): void {
    this.loadData();
  }

  private loadData(): void {
    this.loading.set(true);
    this.error.set('');

    this.apiService.getBonds(1, 5).subscribe({
      next: (res) => {
        this.bonds.set(res.data);
        this.totalBonds.set(res.meta.total);
        this.activeBonds.set(res.data.filter((b: Bond) => b.status === 'Active').length);
        this.loadAccruedCredits(res.data);
      },
      error: () => this.error.set('Failed to load dashboard data'),
    });

    this.apiService.getProjects(1, 5).subscribe({
      next: (res) => {
        this.projects.set(res.data);
        this.totalProjects.set(res.meta.total);
        this.carbonTotal.set(res.data.reduce((sum: number, p: Project) => sum + p.carbonSequestrationEstimate, 0));
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Failed to load dashboard data');
        this.loading.set(false);
      },
    });
  }

  private loadAccruedCredits(bonds: Bond[]): void {
    const holder = this.walletService.address();
    if (!holder) return;

    for (const bond of bonds) {
      this.apiService.getAccruedCredits(bond.id, holder).subscribe({
        next: (accrued) => {
          this.accruedCredits.update((map) => ({ ...map, [bond.id]: accrued }));
        },
        error: () => this.accruedError.set('Failed to load accrued credits'),
      });
    }
  }

  onSubscribe(bondId: string): void {
    this.router.navigate(['/bonds', bondId]);
  }
}
