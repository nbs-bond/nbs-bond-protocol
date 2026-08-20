import { ArgumentsHost, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { Rfc7807ExceptionFilter } from './rfc7807-exception.filter';

describe('Rfc7807ExceptionFilter', () => {
  let filter: Rfc7807ExceptionFilter;
  let mockResponse: any;
  let mockRequest: any;
  let mockArgumentsHost: ArgumentsHost;

  beforeEach(() => {
    filter = new Rfc7807ExceptionFilter();

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    mockRequest = {
      url: '/test-endpoint',
    };

    mockArgumentsHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;
  });

  it('formats unknown generic error as 500 Internal Server Error', () => {
    const error = new Error('Database connection failed');

    filter.catch(error, mockArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(mockResponse.json).toHaveBeenCalledWith({
      type: 'https://errors.nbs-bond-protocol.org/500',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred',
      instance: '/test-endpoint',
      timestamp: expect.any(String),
    });
  });

  it('formats HttpException with string response', () => {
    const exception = new HttpException('Custom Error Message', HttpStatus.FORBIDDEN);

    filter.catch(exception, mockArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(mockResponse.json).toHaveBeenCalledWith({
      type: 'https://errors.nbs-bond-protocol.org/403',
      title: 'Internal Server Error',
      status: 403,
      detail: 'Custom Error Message',
      instance: '/test-endpoint',
      timestamp: expect.any(String),
    });
  });

  it('formats NestJS BadRequestException with object response and array message', () => {
    const exception = new BadRequestException({
      message: ['name should not be empty', 'country must be a valid ISO code'],
      error: 'Bad Request',
      statusCode: 400,
    });

    filter.catch(exception, mockArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockResponse.json).toHaveBeenCalledWith({
      type: 'https://errors.nbs-bond-protocol.org/400',
      title: ['name should not be empty', 'country must be a valid ISO code'],
      status: 400,
      detail: JSON.stringify(['name should not be empty', 'country must be a valid ISO code']),
      instance: '/test-endpoint',
      timestamp: expect.any(String),
    });
  });

  it('formats HttpException with custom detail field', () => {
    const exception = new HttpException(
      { message: 'Resource not found', detail: 'Project with ID 42 does not exist' },
      HttpStatus.NOT_FOUND,
    );

    filter.catch(exception, mockArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(mockResponse.json).toHaveBeenCalledWith({
      type: 'https://errors.nbs-bond-protocol.org/404',
      title: 'Resource not found',
      status: 404,
      detail: 'Project with ID 42 does not exist',
      instance: '/test-endpoint',
      timestamp: expect.any(String),
    });
  });
});
