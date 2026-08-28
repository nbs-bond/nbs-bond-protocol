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
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { token: () => null } },
        { provide: WalletService, useValue: { address: () => null } },
      ],
    });

    service = TestBed.inject(ApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('passes order filters and pagination as query parameters', () => {
    service.getOrders({ bondId: 3, page: 2, limit: 20 }).subscribe();

    const request = httpMock.expectOne(req => req.url === '/api/marketplace/orders');
    expect(request.request.params.get('bondId')).toBe('3');
    expect(request.request.params.get('page')).toBe('2');
    expect(request.request.params.get('limit')).toBe('20');
    request.flush({ data: [], meta: { page: 2, limit: 20, total: 0, totalPages: 1 } });
  });
});
