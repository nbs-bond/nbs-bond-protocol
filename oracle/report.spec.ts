import { buildOracleReport, buildReport, OracleReportError } from './report';
import { OracleReportSchema } from './schemas';

describe('buildOracleReport', () => {
  const validPayload = {
    project_id: 'VCS-1234',
    provider: 'VerraRegistry',
    methodology: 'VERRA-VCS',
    period_start: '2025-01-01',
    period_end: '2025-03-31',
    carbon_sequestered: 50000,
    confidence: 0.95,
    evidence: { verra_report_ids: ['MR-001'] },
  };

  it('builds a canonical oracle report when period_start < period_end', () => {
    const report = buildOracleReport(validPayload);

    expect(report.project_id).toBe('VCS-1234');
    expect(report.provider).toBe('VerraRegistry');
    expect(report.methodology).toBe('VERRA-VCS');
    expect(report.period_start).toBe('2025-01-01');
    expect(report.period_end).toBe('2025-03-31');
    expect(report.carbon_sequestered).toBe(50000);
    expect(report.confidence).toBe(0.95);
    expect(report.ipfs_evidence_hash).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
    expect(report.evidence).toEqual({ verra_report_ids: ['MR-001'] });
  });

  it('works via the buildReport alias', () => {
    const report = buildReport(validPayload);
    expect(report.project_id).toBe('VCS-1234');
    expect(report.period_start).toBe('2025-01-01');
    expect(report.period_end).toBe('2025-03-31');
  });

  it('throws OracleReportError for zero-duration reporting periods (period_start === period_end)', () => {
    expect(() =>
      buildOracleReport({
        ...validPayload,
        period_start: '2025-01-01',
        period_end: '2025-01-01',
      }),
    ).toThrow(OracleReportError);

    expect(() =>
      buildOracleReport({
        ...validPayload,
        period_start: '2025-01-01',
        period_end: '2025-01-01',
      }),
    ).toThrow(
      'Invalid reporting period: period_start (2025-01-01) must be strictly before period_end (2025-01-01)',
    );
  });

  it('throws OracleReportError for negative-duration reporting periods (period_start > period_end)', () => {
    expect(() =>
      buildOracleReport({
        ...validPayload,
        period_start: '2025-03-31',
        period_end: '2025-01-01',
      }),
    ).toThrow(OracleReportError);

    expect(() =>
      buildOracleReport({
        ...validPayload,
        period_start: '2025-03-31',
        period_end: '2025-01-01',
      }),
    ).toThrow(
      'Invalid reporting period: period_start (2025-03-31) must be strictly before period_end (2025-01-01)',
    );
  });

  it('accepts boundary condition of consecutive calendar days', () => {
    const report = buildOracleReport({
      ...validPayload,
      period_start: '2024-12-31',
      period_end: '2025-01-01',
    });
    expect(report.period_start).toBe('2024-12-31');
    expect(report.period_end).toBe('2025-01-01');
  });
});

describe('OracleReportSchema cross-field validation', () => {
  const validReport = {
    project_id: 'VCS-1234',
    provider: 'VerraRegistry',
    methodology: 'VERRA-VCS',
    period_start: '2025-01-01',
    period_end: '2025-03-31',
    carbon_sequestered: 50000,
    confidence: 0.95,
    ipfs_evidence_hash: 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n',
    evidence: { verra_report_ids: ['MR-001'] },
  };

  it('parses valid reports where period_start < period_end', () => {
    const result = OracleReportSchema.safeParse(validReport);
    expect(result.success).toBe(true);
  });

  it('rejects reports when period_start === period_end', () => {
    const result = OracleReportSchema.safeParse({
      ...validReport,
      period_start: '2025-01-01',
      period_end: '2025-01-01',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'period_start must be strictly before period_end',
      );
      expect(result.error.issues[0].path).toEqual(['period_end']);
    }
  });

  it('rejects reports when period_start > period_end', () => {
    const result = OracleReportSchema.safeParse({
      ...validReport,
      period_start: '2025-04-01',
      period_end: '2025-03-31',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'period_start must be strictly before period_end',
      );
    }
  });

  it('rejects invalid date format for period_start or period_end', () => {
    const result = OracleReportSchema.safeParse({
      ...validReport,
      period_start: '2025/01/01',
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative carbon_sequestered', () => {
    const result = OracleReportSchema.safeParse({
      ...validReport,
      carbon_sequestered: -100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects confidence outside [0, 1]', () => {
    expect(
      OracleReportSchema.safeParse({ ...validReport, confidence: 1.5 }).success,
    ).toBe(false);
    expect(
      OracleReportSchema.safeParse({ ...validReport, confidence: -0.1 }).success,
    ).toBe(false);
  });
});
