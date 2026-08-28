import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApiService } from './api.service';
import { AuthService } from '../../auth/auth.service';
import { WalletService } from '../../auth/wallet.service';

describe('ApiService', () => {
  let service: ApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ApiService,
        AuthService,
        WalletService,
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    service = TestBed.inject(ApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('gets bond periods with pagination and report query params', () => {
    service.getBondPeriods(7, 2, 10, true).subscribe();

    const request = httpMock.expectOne('/api/bonds/7/periods?page=2&limit=10&includeReport=true');
    expect(request.request.method).toBe('GET');
    request.flush({ data: [], meta: { page: 2, limit: 10, total: 0, totalPages: 1 } });
  });
});
