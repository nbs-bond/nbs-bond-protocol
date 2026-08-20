import { ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { RequestLoggingInterceptor } from './request-logging.interceptor';

describe('RequestLoggingInterceptor', () => {
  let interceptor: RequestLoggingInterceptor;
  let mockRequest: any;
  let mockContext: ExecutionContext;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    interceptor = new RequestLoggingInterceptor();
    mockRequest = { method: 'GET', url: '/api/v1/bonds' };

    mockContext = {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
    } as unknown as ExecutionContext;

    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('assigns requestId to request and logs request start and duration on success', (done) => {
    const mockCallHandler: CallHandler = {
      handle: () => of({ data: 'success' }),
    };

    interceptor.intercept(mockContext, mockCallHandler).subscribe({
      next: (val) => {
        expect(val).toEqual({ data: 'success' });
        expect(mockRequest.requestId).toBeDefined();
        expect(typeof mockRequest.requestId).toBe('string');

        expect(logSpy).toHaveBeenCalledWith(
          expect.stringContaining(`[${mockRequest.requestId}] GET /api/v1/bonds`),
        );
        expect(logSpy).toHaveBeenCalledWith(
          expect.stringContaining(`[${mockRequest.requestId}]`),
        );
        done();
      },
    });
  });

  it('logs error when handle observable throws error', (done) => {
    const error = new Error('Test Failure');
    const mockCallHandler: CallHandler = {
      handle: () => throwError(() => error),
    };

    interceptor.intercept(mockContext, mockCallHandler).subscribe({
      error: (err) => {
        expect(err).toBe(error);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining(`[${mockRequest.requestId}] Test Failure`),
          error.stack,
        );
        done();
      },
    });
  });
});
