import { classifyAdapterError, isTransientAdapterError } from './failure';
import { VerraSchemaError, VerraNotFoundError, VerraNoVerifiedReportsError } from './verra-adapter';
import { SatelliteSchemaError, SatelliteNoUsableScenesError } from './satellite-processor';
import { IotSchemaError, IotNoValidReadingsError } from './iot-aggregator';
import { BlueCarbonSchemaError, BlueCarbonNoSurveysError } from './blue-carbon-adapter';
import { OracleReportError } from './report';

describe('classifyAdapterError', () => {
  it('classifies schema validation errors as permanent', () => {
    expect(classifyAdapterError(new VerraSchemaError('project VCS-1', []))).toBe('permanent');
    expect(classifyAdapterError(new SatelliteSchemaError('scenes', []))).toBe('permanent');
    expect(classifyAdapterError(new IotSchemaError('readings', []))).toBe('permanent');
    expect(classifyAdapterError(new BlueCarbonSchemaError('surveys', []))).toBe('permanent');
  });

  it('classifies not-found and empty-data errors as permanent', () => {
    expect(classifyAdapterError(new VerraNotFoundError('VCS-999'))).toBe('permanent');
    expect(classifyAdapterError(new VerraNoVerifiedReportsError('VCS-1', '2025-01-01', '2025-03-31'))).toBe('permanent');
    expect(classifyAdapterError(new SatelliteNoUsableScenesError('2025-01-01', '2025-03-31', 20))).toBe('permanent');
    expect(classifyAdapterError(new IotNoValidReadingsError(['NBS-1'], '2025-01-01', '2025-03-31'))).toBe('permanent');
    expect(classifyAdapterError(new BlueCarbonNoSurveysError('BLUE-1', '2025-01-01', '2025-03-31'))).toBe('permanent');
    expect(classifyAdapterError(new OracleReportError('invalid report'))).toBe('permanent');
  });

  it('classifies network and timeout errors as transient', () => {
    expect(classifyAdapterError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe('transient');
    expect(classifyAdapterError(new Error('socket hang up'))).toBe('transient');
    expect(classifyAdapterError(new Error('getaddrinfo ENOTFOUND registry.verra.org'))).toBe('transient');
    expect(classifyAdapterError(new Error('connect ECONNREFUSED 127.0.0.1:5001'))).toBe('transient');
  });

  it('classifies 5xx / 429 / 408 upstream responses as transient', () => {
    expect(classifyAdapterError(new Error('upstream returned status 503'))).toBe('transient');
    expect(classifyAdapterError(new Error('upstream returned status 500'))).toBe('transient');
    expect(classifyAdapterError(new Error('upstream returned status 429'))).toBe('transient');
    expect(classifyAdapterError(new Error('upstream returned status 408'))).toBe('transient');
  });

  it('classifies other 4xx responses as permanent', () => {
    expect(classifyAdapterError(new Error('Verra registry returned status 401 for project VCS-1'))).toBe('permanent');
    expect(classifyAdapterError(new Error('upstream returned status 400'))).toBe('permanent');
  });

  it('defaults unknown errors to transient so the next cycle retries', () => {
    expect(classifyAdapterError(new Error('something unexpected'))).toBe('transient');
    expect(classifyAdapterError('not even an error')).toBe('transient');
    expect(classifyAdapterError(undefined)).toBe('transient');
    expect(isTransientAdapterError(new Error('boom'))).toBe(true);
    expect(isTransientAdapterError(new VerraSchemaError('x', []))).toBe(false);
  });
});
