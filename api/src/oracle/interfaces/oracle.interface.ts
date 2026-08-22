export enum ReportStatus {
  Pending = 'Pending',
  Verified = 'Verified',
  Challenged = 'Challenged',
  Rejected = 'Rejected',
}

export interface ReportResponse {
  id: number;
  projectId: string;
  periodStart: number;
  periodEnd: number;
  carbonSequestered: number;
  methodology: string;
  ipfsHash: string;
  providerAddress: string;
  status: ReportStatus;
  createdAt: string;
  verifiedAt?: string;
}

export interface ChallengeResponse {
  reportId: number;
  challengerAddress: string;
  reason: string;
  counterEvidenceHash: string;
  resolved: boolean;
  createdAt: string;
}

/**
 * Returned by the `/prepare` step of the pre-signed-transaction challenge
 * flow (see OracleService.prepareChallenge()). `xdr` is an UNSIGNED base64
 * transaction envelope the challenger's wallet must sign and post back to
 * POST /oracle/challenge/:reportId; `nonce` is the contract-level nonce
 * reserved for that submission.
 */
export interface ChallengePrepareResponse {
  xdr: string;
  nonce: number;
}

export type ProviderHealthState = 'healthy' | 'stale' | 'unknown';

export interface ProviderHealthStatus {
  status: ProviderHealthState;
  lastVerifiedAt?: string;
  expectedNextReportAt?: string;
  stalenessSeconds?: number;
  projectIds: string[];
}

export interface ProviderResponse {
  providerAddress: string;
  methodology: string;
  name: string;
  active: boolean;
  registeredAt: string;
  stake?: number;
  health?: ProviderHealthStatus;
}

export interface SlashRecord {
  reportId: number;
  penalty: number;
  remainingStake: number;
  timestamp: string;
  activeAfter: boolean;
}

export interface ChallengeRecord {
  reportId: number;
  challengerAddress: string;
  counterEvidenceHash: string;
  submittedAt: string;
  resolved: boolean;
  resolution: ReportStatus | null;
}

export interface ProviderStatsResponse {
  providerAddress: string;
  reportsSubmitted: number;
  challengesFaced: number;
  slashes: number;
  totalPenalty: number;
  stake: number;
  active: boolean;
}

export interface ProviderStatsWithHistory extends ProviderStatsResponse {
  slashHistory: SlashRecord[];
  challengeHistory: ChallengeRecord[];
}

export interface StalenessMetric {
  projectId: string;
  providerAddress?: string;
  lastVerifiedAt?: string;
  expectedCadenceSeconds: number;
  graceSeconds: number;
  expectedNextReportAt?: string;
  stalenessSeconds?: number;
  isStale: boolean;
}

export interface ProviderStalenessMetric {
  providerAddress: string;
  lastVerifiedAt?: string;
  expectedNextReportAt?: string;
  stalenessSeconds?: number;
  isStale: boolean;
  projectIds: string[];
}

export interface OracleStalenessReport {
  asOf: string;
  projects: StalenessMetric[];
  providers: ProviderStalenessMetric[];
}
