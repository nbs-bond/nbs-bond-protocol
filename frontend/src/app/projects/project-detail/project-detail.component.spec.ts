import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, ActivatedRoute, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { ProjectDetailComponent } from './project-detail.component';
import { ApiService } from '../../shared/services/api.service';
import { Project } from '../../shared/interfaces/bond.interface';

describe('ProjectDetailComponent', () => {
  let fixture: ComponentFixture<ProjectDetailComponent>;
  let component: ProjectDetailComponent;
  let apiService: jasmine.SpyObj<ApiService>;
  let router: Router;

  const project: Project = {
    id: 7,
    name: 'Amazon Reforestation',
    status: 'Approved',
    methodology: 'VM0015',
    country: 'BR',
    metadataIpfsHash: 'bafyTestHash',
    ownerAddress: 'GOWNERADDRESS',
    totalAreaHa: 10000,
    carbonSequestrationEstimate: 50000,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const configure = async (paramId: string | null, projectResponse = of(project)): Promise<void> => {
    TestBed.resetTestingModule();
    apiService = jasmine.createSpyObj('ApiService', ['getProject']);
    apiService.getProject.and.returnValue(projectResponse);

    await TestBed.configureTestingModule({
      imports: [ProjectDetailComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: { get: () => paramId } } },
        },
        { provide: ApiService, useValue: apiService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ProjectDetailComponent);
    component = fixture.componentInstance;
    router = TestBed.inject(Router);
    spyOn(router, 'navigate');
  };

  afterEach(() => {
    fixture?.destroy();
  });

  it('creates and resolves the project from the route id', async () => {
    await configure('7');
    fixture.detectChanges();
    expect(component).toBeTruthy();
    expect(apiService.getProject).toHaveBeenCalledOnceWith(7);
    expect(component.project()?.id).toBe(7);
    expect(component.loading()).toBe(false);
    expect(fixture.nativeElement.querySelector('.detail-card')).not.toBeNull();
  });

  it('renders the project fields', async () => {
    await configure('7');
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Amazon Reforestation');
    expect(text).toContain('VM0015');
    expect(text).toContain('BR');
    expect(text).toContain('GOWNERADDRESS');
  });

  it('builds an IPFS metadata url when a hash is present', async () => {
    await configure('7');
    fixture.detectChanges();
    expect(component.metadataUrl()).toBe(
      'https://gateway.pinata.cloud/ipfs/bafyTestHash',
    );
  });

  it('falls back to a placeholder metadata url when no hash is set', async () => {
    await configure('7', of({ ...project, metadataIpfsHash: '' }));
    fixture.detectChanges();
    expect(component.metadataUrl()).toBe('#');
  });

  it('redirects to not-found when the route id is missing', async () => {
    await configure(null);
    fixture.detectChanges();
    expect(router.navigate).toHaveBeenCalledWith(['/not-found']);
    expect(apiService.getProject).not.toHaveBeenCalled();
  });

  it('redirects to not-found on a 404 response', async () => {
    await configure('7', throwError(() => ({ status: 404 })));
    fixture.detectChanges();
    expect(router.navigate).toHaveBeenCalledWith(['/not-found']);
  });

  it('surfaces a generic error for non-404 failures', async () => {
    await configure('7', throwError(() => ({ status: 500 })));
    fixture.detectChanges();
    expect(component.loading()).toBe(false);
    expect(component.error()).toBe('Failed to load project');
    expect(router.navigate).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.error-card')).not.toBeNull();
  });
});
