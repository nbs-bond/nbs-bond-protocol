import { Component, inject, OnInit, ChangeDetectionStrategy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../../shared/services/api.service';
import { StatusBadgeComponent } from '../../shared/components/status-badge/status-badge.component';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner.component';
import { Project } from '../../shared/interfaces/bond.interface';

@Component({
  selector: 'app-project-detail',
  standalone: true,
  imports: [CommonModule, RouterModule, StatusBadgeComponent, LoadingSpinnerComponent],
  template: `
    <div class="detail-page">
      <a class="back-link" routerLink="/projects">← Back to Projects</a>

      @if (project(); as p) {
        <div class="detail-card">
          <div class="detail-header">
            <h1 class="detail-title">{{ p.name }}</h1>
            <app-status-badge [status]="p.status" variant="project" />
          </div>

          <div class="detail-body">
            <div class="detail-field">
              <span class="field-label">Project ID</span>
              <span class="field-value">{{ p.id }}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Methodology</span>
              <span class="field-value mono">{{ p.methodology }}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Country</span>
              <span class="field-value">{{ p.country }}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Total Area</span>
              <span class="field-value">{{ p.totalAreaHa | number }} ha</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Carbon Estimate</span>
              <span class="field-value">{{ p.carbonSequestrationEstimate | number }} tCO₂e</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Owner Address</span>
              <span class="field-value mono">{{ p.ownerAddress }}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Created</span>
              <span class="field-value">{{ p.createdAt | date }}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Metadata</span>
              <a class="field-value link" [href]="metadataUrl()" target="_blank" rel="noopener noreferrer">View on IPFS →</a>
            </div>
          </div>
        </div>
      } @else if (loading()) {
        <div class="loading-section"><app-loading-spinner size="lg" /></div>
      } @else if (error()) {
        <div class="error-card">{{ error() }}</div>
      }
    </div>
  `,
  styles: [`
    .detail-page { max-width: 800px; }
    .back-link { display: inline-block; margin-bottom: 24px; color: #3b82f6; text-decoration: none; font-size: 0.875rem; }
    .back-link:hover { text-decoration: underline; }
    .loading-section { display: flex; justify-content: center; padding: 48px 0; }
    .error-card { background: #fef2f2; color: #ef4444; padding: 24px; border-radius: 12px; text-align: center; }
    .detail-card { background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .detail-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .detail-title { font-size: 1.5rem; font-weight: 700; }
    .detail-body { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .detail-field { display: flex; flex-direction: column; }
    .field-label { font-size: 0.75rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .field-value { font-size: 0.9375rem; color: #1a1a2e; }
    .field-value.mono { font-family: monospace; font-size: 0.8125rem; word-break: break-all; }
    .field-value.link { color: #3b82f6; text-decoration: none; }
    .field-value.link:hover { text-decoration: underline; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly apiService = inject(ApiService);

  readonly project = signal<Project | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');

  metadataUrl(): string {
    const p = this.project();
    return p?.metadataIpfsHash ? `https://gateway.pinata.cloud/ipfs/${p.metadataIpfsHash}` : '#';
  }

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id) {
      void this.router.navigate(['/not-found']);
      return;
    }
    this.apiService.getProject(id).subscribe({
      next: (project) => {
        this.project.set(project);
        this.loading.set(false);
      },
      error: (err) => {
        if (err.status === 404) {
          void this.router.navigate(['/not-found']);
          return;
        }
        this.error.set('Failed to load project');
        this.loading.set(false);
      },
    });
  }
}
