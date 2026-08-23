import { Component, inject, ChangeDetectionStrategy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ApiService } from '../../shared/services/api.service';
import { latitudeValidator, longitudeValidator } from '../../shared/validators/form-validators';

@Component({
  selector: 'app-project-create',
  standalone: true,
  imports: [CommonModule, RouterModule, ReactiveFormsModule],
  template: `
    <div class="create-page">
      <a class="back-link" routerLink="/projects">← Back to Projects</a>
      <h1 class="page-title">Register New Project</h1>

      @if (error()) {
        <div class="error-banner">{{ error() }}</div>
      }

      <form class="create-form" [formGroup]="form" (ngSubmit)="onSubmit()">
        <div class="form-group">
          <label class="form-label" for="name">Project Name</label>
          <input id="name" class="form-input" formControlName="name" placeholder="Amazon Reforestation Phase 3" />
          @if (form.get('name')?.invalid && form.get('name')?.touched) {
            <span class="form-error">Name is required</span>
          }
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="methodology">Methodology</label>
            <input id="methodology" class="form-input" formControlName="methodology" placeholder="VM0015" />
            @if (form.get('methodology')?.invalid && form.get('methodology')?.touched) {
              <span class="form-error">Methodology is required</span>
            }
          </div>
          <div class="form-group">
            <label class="form-label" for="country">Country</label>
            <input id="country" class="form-input" formControlName="country" placeholder="BR" />
            @if (form.get('country')?.invalid && form.get('country')?.touched) {
              <span class="form-error">Country is required</span>
            }
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="totalAreaHa">Total Area (ha)</label>
            <input id="totalAreaHa" type="number" class="form-input" formControlName="totalAreaHa" placeholder="10000" />
            @if (form.get('totalAreaHa')?.invalid && form.get('totalAreaHa')?.touched) {
              <span class="form-error">Enter a positive number</span>
            }
          </div>
          <div class="form-group">
            <label class="form-label" for="carbonSequestrationEstimate">Carbon Estimate (tCO₂e)</label>
            <input id="carbonSequestrationEstimate" type="number" class="form-input" formControlName="carbonSequestrationEstimate" placeholder="50000" />
            @if (form.get('carbonSequestrationEstimate')?.invalid && form.get('carbonSequestrationEstimate')?.touched) {
              <span class="form-error">Enter a positive number</span>
            }
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="blueCarbon">
              <input id="blueCarbon" type="checkbox" class="form-checkbox" formControlName="blueCarbon" />
              Blue Carbon Project (mangrove / seagrass / saltmarsh)
            </label>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="locationLat">Latitude</label>
            <input id="locationLat" type="number" step="0.000001" class="form-input" formControlName="locationLat" placeholder="-3.4653" />
            @if (form.get('locationLat')?.invalid && form.get('locationLat')?.touched) {
              @if (form.get('locationLat')?.errors?.['required']) {
                <span class="form-error">Latitude is required</span>
              } @else if (form.get('locationLat')?.errors?.['latitudeRange']) {
                <span class="form-error">Latitude must be between -90 and 90</span>
              }
            }
          </div>
          <div class="form-group">
            <label class="form-label" for="locationLng">Longitude</label>
            <input id="locationLng" type="number" step="0.000001" class="form-input" formControlName="locationLng" placeholder="-62.2159" />
            @if (form.get('locationLng')?.invalid && form.get('locationLng')?.touched) {
              @if (form.get('locationLng')?.errors?.['required']) {
                <span class="form-error">Longitude is required</span>
              } @else if (form.get('locationLng')?.errors?.['longitudeRange']) {
                <span class="form-error">Longitude must be between -180 and 180</span>
              }
            }
          </div>
        </div>

        <div class="form-actions">
          <a class="btn btn-outline" routerLink="/projects">Cancel</a>
          <button type="submit" class="btn btn-primary" [disabled]="form.invalid || submitting()">
            {{ submitting() ? 'Registering...' : 'Register Project' }}
          </button>
        </div>
      </form>
    </div>
  `,
  styles: [`
    .create-page { max-width: 640px; }
    .back-link { display: inline-block; margin-bottom: 16px; color: #3b82f6; text-decoration: none; font-size: 0.875rem; }
    .back-link:hover { text-decoration: underline; }
    .page-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 24px; }
    .error-banner { background: #fef2f2; color: #ef4444; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.875rem; }
    .create-form { background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .form-group { display: flex; flex-direction: column; margin-bottom: 20px; flex: 1; }
    .form-label { font-size: 0.8125rem; font-weight: 600; color: #1a1a2e; margin-bottom: 6px; }
    .form-input { padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.875rem; outline: none; transition: border-color 0.15s; }
    .form-input:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.15); }
    .form-error { font-size: 0.75rem; color: #ef4444; margin-top: 4px; }
    .form-checkbox { width: 16px; height: 16px; margin-right: 8px; accent-color: #1a1a2e; }
    .form-row { display: flex; gap: 16px; }
    .form-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e7eb; }
    .btn { padding: 10px 20px; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; text-decoration: none; display: inline-block; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #2a2a4e; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-outline { background: #fff; color: #1a1a2e; border: 1px solid #d1d5db; }
    .btn-outline:hover { background: #f0f2f5; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectCreateComponent {
  private readonly fb = inject(FormBuilder);
  private readonly apiService = inject(ApiService);
  private readonly router = inject(Router);

  readonly submitting = signal(false);
  readonly error = signal('');

  form: FormGroup = this.fb.group({
    name: ['', Validators.required],
    methodology: ['', Validators.required],
    country: ['', Validators.required],
    totalAreaHa: [null, [Validators.required, Validators.min(0.01)]],
    carbonSequestrationEstimate: [null, [Validators.required, Validators.min(0.01)]],
    blueCarbon: [false],
    locationLat: [null, [Validators.required, latitudeValidator()]],
    locationLng: [null, [Validators.required, longitudeValidator()]],
  });

  onSubmit(): void {
    if (this.form.invalid) return;
    this.submitting.set(true);
    this.error.set('');

    const formValue = { ...this.form.value };
    formValue.location = {
      lat: Number(formValue.locationLat),
      lng: Number(formValue.locationLng),
    };
    delete formValue.locationLat;
    delete formValue.locationLng;

    this.apiService.registerProject(formValue).subscribe({
      next: (project) => {
        this.router.navigate(['/projects', project.id]);
      },
      error: (err) => {
        this.error.set(err.error?.detail || err.message || 'Failed to register project');
        this.submitting.set(false);
      },
    });
  }
}
