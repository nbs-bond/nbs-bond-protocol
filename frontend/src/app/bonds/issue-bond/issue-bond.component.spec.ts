import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { IssueBondComponent } from './issue-bond.component';
import { ApiService } from '../../shared/services/api.service';

describe('IssueBondComponent', () => {
  let fixture: ComponentFixture<IssueBondComponent>;
  let component: IssueBondComponent;
  let apiService: jasmine.SpyObj<ApiService>;
  let router: Router;

  beforeEach(async () => {
    apiService = jasmine.createSpyObj('ApiService', ['issueBond']);

    await TestBed.configureTestingModule({
      imports: [IssueBondComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: apiService },
      ],
    }).compileComponents();

    router = TestBed.inject(Router);
    spyOn(router, 'navigate');
    fixture = TestBed.createComponent(IssueBondComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    fixture?.destroy();
  });

  it('creates and renders the issue form without errors', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.issue-form')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#projectId')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#couponSchedule')).not.toBeNull();
  });

  it('is invalid while required fields are empty', () => {
    fixture.detectChanges();
    expect(component.form.invalid).toBe(true);
    expect(component.form.get('projectId')?.hasError('required')).toBe(true);
    expect(component.form.get('faceValue')?.hasError('required')).toBe(true);
    expect(component.form.get('maturityDate')?.hasError('required')).toBe(true);
    expect(component.form.get('couponSchedule')?.hasError('required')).toBe(true);
  });

  it('rejects non-positive face value and total supply', () => {
    fixture.detectChanges();
    component.form.patchValue({ faceValue: 0, totalSupply: -5 });
    expect(component.form.get('faceValue')?.hasError('min')).toBe(true);
    expect(component.form.get('totalSupply')?.hasError('min')).toBe(true);
  });

  it('becomes valid once all fields are filled correctly', () => {
    fixture.detectChanges();
    component.form.patchValue({
      projectId: 'abc123',
      faceValue: 100000,
      creditType: 'Carbon',
      totalSupply: 1000,
      maturityDate: '2027-01-01',
      couponSchedule: '1750000000, 1781536000',
    });
    expect(component.form.valid).toBe(true);
  });

  it('submits the form and issues the bond with a parsed coupon schedule', fakeAsync(() => {
    apiService.issueBond.and.returnValue(of({} as any));
    fixture.detectChanges();

    component.form.patchValue({
      projectId: 'abc123',
      faceValue: 100000,
      creditType: 'Basket',
      totalSupply: 1000,
      maturityDate: '2027-01-01',
      couponSchedule: '1750000000, 1781536000, not-a-number',
    });
    component.form.markAllAsTouched();

    component.onSubmit();

    expect(apiService.issueBond).toHaveBeenCalledTimes(1);

    const payload = apiService.issueBond.calls.mostRecent().args[0];
    expect(payload.projectId).toBe('abc123');
    expect(payload.faceValue).toBe(100000);
    expect(payload.creditType).toBe('Basket');
    expect(payload.totalSupply).toBe(1000);
    expect(payload.maturityDate).toBe(new Date('2027-01-01').getTime());
    expect(payload.couponSchedule).toEqual([1750000000, 1781536000]);

    // The mocked response completes synchronously, so success is set immediately.
    fixture.detectChanges();
    expect(component.success()).toBe(true);
    expect(component.submitting()).toBe(false);

    tick(1500);
    expect(router.navigate).toHaveBeenCalledWith(['/bonds']);
  }));

  it('does not call issueBond when the form is invalid', () => {
    fixture.detectChanges();
    component.form.patchValue({ projectId: '' });
    component.onSubmit();
    expect(apiService.issueBond).not.toHaveBeenCalled();
  });

  it('surfaces an error message when issuance fails', () => {
    apiService.issueBond.and.returnValue(
      throwError(() => ({ error: { detail: 'Project not found' } })),
    );
    fixture.detectChanges();

    component.form.patchValue({
      projectId: 'abc123',
      faceValue: 100000,
      creditType: 'Carbon',
      totalSupply: 1000,
      maturityDate: '2027-01-01',
      couponSchedule: '1750000000',
    });
    component.onSubmit();
    fixture.detectChanges();

    expect(component.submitting()).toBe(false);
    expect(component.error()).toBe('Project not found');
    expect(fixture.nativeElement.querySelector('.error-banner')).not.toBeNull();
  });
});
