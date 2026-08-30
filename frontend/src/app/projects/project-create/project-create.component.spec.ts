import { ComponentFixture, TestBed, fakeAsync } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { ProjectCreateComponent } from './project-create.component';
import { ApiService } from '../../shared/services/api.service';
import { Project } from '../../shared/interfaces/bond.interface';

describe('ProjectCreateComponent', () => {
  let fixture: ComponentFixture<ProjectCreateComponent>;
  let component: ProjectCreateComponent;
  let apiService: jasmine.SpyObj<ApiService>;
  let router: Router;

  const createdProject: Project = {
    id: 42,
    name: 'Amazon Reforestation',
    status: 'Pending',
    methodology: 'VM0015',
    country: 'BR',
    metadataIpfsHash: '',
    ownerAddress: '',
    totalAreaHa: 10000,
    carbonSequestrationEstimate: 50000,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    apiService = jasmine.createSpyObj('ApiService', ['registerProject']);
    apiService.registerProject.and.returnValue(of(createdProject));

    await TestBed.configureTestingModule({
      imports: [ProjectCreateComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: apiService },
      ],
    }).compileComponents();

    router = TestBed.inject(Router);
    spyOn(router, 'navigate');
    fixture = TestBed.createComponent(ProjectCreateComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    fixture?.destroy();
  });

  it('creates and renders the registration form without errors', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.create-form')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#name')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#country')).not.toBeNull();
  });

  it('is invalid while required fields are empty', () => {
    fixture.detectChanges();
    expect(component.form.invalid).toBe(true);
    expect(component.form.get('name')?.hasError('required')).toBe(true);
    expect(component.form.get('methodology')?.hasError('required')).toBe(true);
    expect(component.form.get('country')?.hasError('required')).toBe(true);
    expect(component.form.get('totalAreaHa')?.hasError('required')).toBe(true);
    expect(component.form.get('locationLat')?.hasError('required')).toBe(true);
    expect(component.form.get('locationLng')?.hasError('required')).toBe(true);
  });

  it('rejects non-positive area and carbon estimates', () => {
    fixture.detectChanges();
    component.form.patchValue({ totalAreaHa: 0, carbonSequestrationEstimate: -1 });
    expect(component.form.get('totalAreaHa')?.hasError('min')).toBe(true);
    expect(component.form.get('carbonSequestrationEstimate')?.hasError('min')).toBe(true);
  });

  it('rejects out-of-range coordinates', () => {
    fixture.detectChanges();
    component.form.patchValue({ locationLat: 100, locationLng: 200 });
    expect(component.form.get('locationLat')?.hasError('latitudeRange')).toBe(true);
    expect(component.form.get('locationLng')?.hasError('longitudeRange')).toBe(true);

    component.form.patchValue({ locationLat: -3.4, locationLng: -62.2 });
    expect(component.form.get('locationLat')?.valid).toBe(true);
    expect(component.form.get('locationLng')?.valid).toBe(true);
  });

  it('becomes valid with a fully populated, in-range form', () => {
    fixture.detectChanges();
    component.form.patchValue({
      name: 'Amazon Reforestation Phase 3',
      methodology: 'VM0015',
      country: 'BR',
      totalAreaHa: 10000,
      carbonSequestrationEstimate: 50000,
      blueCarbon: true,
      locationLat: -3.4653,
      locationLng: -62.2159,
    });
    expect(component.form.valid).toBe(true);
  });

  it('submits and registers the project, mapping coordinates into a location object', fakeAsync(() => {
    fixture.detectChanges();

    component.form.patchValue({
      name: 'Amazon Reforestation Phase 3',
      methodology: 'VM0015',
      country: 'BR',
      totalAreaHa: 10000,
      carbonSequestrationEstimate: 50000,
      blueCarbon: true,
      locationLat: -3.4653,
      locationLng: -62.2159,
    });
    component.form.markAllAsTouched();

    component.onSubmit();

    expect(apiService.registerProject).toHaveBeenCalledTimes(1);

    const payload = apiService.registerProject.calls.mostRecent().args[0] as any;
    expect(payload.name).toBe('Amazon Reforestation Phase 3');
    expect(payload.country).toBe('BR');
    expect(payload.blueCarbon).toBe(true);
    expect(payload.location).toEqual({ lat: -3.4653, lng: -62.2159 });
    expect(payload.locationLat).toBeUndefined();
    expect(payload.locationLng).toBeUndefined();

    // The mocked response completes synchronously and navigates away.
    fixture.detectChanges();
    expect(router.navigate).toHaveBeenCalledWith(['/projects', 42]);
    expect(router.navigate).toHaveBeenCalledWith(['/projects', 42]);
  }));

  it('does not call registerProject when the form is invalid', () => {
    fixture.detectChanges();
    component.form.patchValue({ name: '' });
    component.onSubmit();
    expect(apiService.registerProject).not.toHaveBeenCalled();
  });

  it('surfaces an error message when registration fails', () => {
    apiService.registerProject.and.returnValue(
      throwError(() => ({ error: { detail: 'Methodology rejected' } })),
    );
    fixture.detectChanges();

    component.form.patchValue({
      name: 'Amazon Reforestation Phase 3',
      methodology: 'VM0015',
      country: 'BR',
      totalAreaHa: 10000,
      carbonSequestrationEstimate: 50000,
      locationLat: -3.4653,
      locationLng: -62.2159,
    });
    component.onSubmit();
    fixture.detectChanges();

    expect(component.submitting()).toBe(false);
    expect(component.error()).toBe('Methodology rejected');
    expect(fixture.nativeElement.querySelector('.error-banner')).not.toBeNull();
  });
});
