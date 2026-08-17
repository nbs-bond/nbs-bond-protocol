import { hashEvidence } from '../ipfs/evidence';
import { OracleReportSchema, OracleReport, ReportEvidence } from './schemas';

export class OracleReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OracleReportError';
  }
}

export interface BuildReportInput {
  project_id: string;
  provider: string;
  methodology: string;
  period_start: string;
  period_end: string;
  carbon_sequestered: number;
  confidence: number;
  evidence: ReportEvidence;
}

/**
 * Assemble a canonical oracle report, hash its evidence payload into
 * `ipfs_evidence_hash`, and validate the result against `OracleReportSchema`.
 */
export function buildOracleReport(input: BuildReportInput): OracleReport {
  if (input.period_start >= input.period_end) {
    throw new OracleReportError(
      `Invalid reporting period: period_start (${input.period_start}) must be strictly before period_end (${input.period_end})`,
    );
  }

  const payload = {
    project_id: input.project_id,
    provider: input.provider,
    methodology: input.methodology,
    period_start: input.period_start,
    period_end: input.period_end,
    carbon_sequestered: input.carbon_sequestered,
    confidence: input.confidence,
    evidence: input.evidence,
    generated_at: new Date().toISOString(),
  };

  const { ipfs_evidence_hash } = hashEvidence(payload);

  return OracleReportSchema.parse({
    project_id: input.project_id,
    provider: input.provider,
    methodology: input.methodology,
    period_start: input.period_start,
    period_end: input.period_end,
    carbon_sequestered: input.carbon_sequestered,
    confidence: input.confidence,
    ipfs_evidence_hash,
    evidence: input.evidence,
  });
}

/** Alias for `buildOracleReport`. */
export const buildReport = buildOracleReport;
