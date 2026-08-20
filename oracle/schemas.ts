import { z } from 'zod';

/**
 * Shared schemas for the oracle adapters.
 *
 * Every adapter validates the payload it receives from an upstream endpoint
 * against these schemas *before* producing a report. The output schema mirrors
 * the on-chain `Report` struct in `contracts/oracle-consumer` (snake_case
 * fields, `carbon_sequestered` expressed in kg CO2e).
 */

/** ISO-8601 calendar date (`YYYY-MM-DD`), as used for reporting periods. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected date in YYYY-MM-DD format');

/** Methodology symbols compatible with the on-chain `Symbol` field. */
export const METHODOLOGY = {
  VERRA_VCS: 'VERRA-VCS',
  REMOTE_SENSING: 'REMOTE-SENSING',
  IOT_SENSORS: 'IOT-SENSORS',
  BLUE_CARBON: 'BLUE-CARBON',
} as const;

// ─────────────────────────── Verra registry ───────────────────────────

export const VerraProjectSchema = z.object({
  project_id: z.string().min(1),
  name: z.string().min(1),
  registry: z.string().min(1).default('VERRA-VCS'),
  status: z.enum(['REGISTERED', 'ACTIVE', 'COMPLETED', 'WITHDRAWN']),
  methodologies: z.array(z.string().min(1)).default([]),
});
export type VerraProject = z.infer<typeof VerraProjectSchema>;

export const VerraMonitoringReportSchema = z.object({
  report_id: z.string().min(1),
  verification_status: z.enum(['VERIFIED', 'PENDING', 'REJECTED']),
  verification_date: isoDate,
  reporting_period_start: isoDate,
  reporting_period_end: isoDate,
  methodology: z.string().min(1),
  carbon_sequestered_kg: z.number().nonnegative(),
  credits_issued: z.number().nonnegative(),
});
export type VerraMonitoringReport = z.infer<typeof VerraMonitoringReportSchema>;

export const VerraReportListSchema = z.object({
  reports: z.array(VerraMonitoringReportSchema),
});

// ─────────────────────────── Satellite imagery ─────────────────────────

export const SatelliteSceneSchema = z.object({
  scene_id: z.string().min(1),
  capture_date: isoDate,
  source: z.enum(['sentinel-2', 'landsat-8', 'planet']),
  cloud_cover: z.number().min(0).max(100),
  ndvi_mean: z.number().min(-1).max(1),
  ndwi_mean: z.number().min(-1).max(1).optional(),
});
export type SatelliteScene = z.infer<typeof SatelliteSceneSchema>;

export const SatelliteSceneListSchema = z.object({
  scenes: z.array(SatelliteSceneSchema),
});

export const SatelliteProjectConfigSchema = z.object({
  project_id: z.string().min(1),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  area_ha: z.number().positive(),
  baseline_ndvi: z.number().min(-1).max(1),
});
export type SatelliteProjectConfig = z.infer<typeof SatelliteProjectConfigSchema>;

// ─────────────────────────────── IoT sensors ──────────────────────────

export const IoTSensorMetricsSchema = z.object({
  soil_moisture: z.number().min(0).max(100).nullable(),
  temperature: z.number().min(-50).max(60).nullable(),
  humidity: z.number().min(0).max(100).nullable(),
  soil_carbon_ppm: z.number().nonnegative().nullable(),
  water_table_cm: z.number().nullable(),
  co2_ppm: z.number().nonnegative().nullable(),
});
export type IoTSensorMetrics = z.infer<typeof IoTSensorMetricsSchema>;

export const IoTSensorReadingSchema = z.object({
  device_id: z.string().min(1),
  timestamp: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'expected an ISO-8601 timestamp',
  }),
  metrics: IoTSensorMetricsSchema,
});
export type IoTSensorReading = z.infer<typeof IoTSensorReadingSchema>;

export const IoTReadingListSchema = z.object({
  readings: z.array(IoTSensorReadingSchema),
});

export const IotProjectConfigSchema = z.object({
  project_id: z.string().min(1),
  device_ids: z.array(z.string().min(1)).min(1),
  area_ha: z.number().positive(),
});
export type IotProjectConfig = z.infer<typeof IotProjectConfigSchema>;

// ─────────────────────────── Blue carbon ──────────────────────────

/** Per-plot survey of a blue carbon ecosystem (mangrove/seagrass/saltmarsh). */
export const BlueCarbonSurveySchema = z.object({
  survey_id: z.string().min(1),
  survey_date: isoDate,
  habitat: z.enum(['mangrove', 'seagrass', 'saltmarsh']),
  plot_area_ha: z.number().positive(),
  aboveground_biomass_t_per_ha: z.number().nonnegative(),
  belowground_biomass_t_per_ha: z.number().nonnegative(),
  soil_organic_carbon_t_per_ha: z.number().nonnegative(),
  bulk_density_g_cm3: z.number().positive().optional(),
});
export type BlueCarbonSurvey = z.infer<typeof BlueCarbonSurveySchema>;

export const BlueCarbonSurveyListSchema = z.object({
  surveys: z.array(BlueCarbonSurveySchema),
});

export const BlueCarbonProjectConfigSchema = z.object({
  project_id: z.string().min(1),
  habitat: z.enum(['mangrove', 'seagrass', 'saltmarsh']),
  area_ha: z.number().positive(),
  baseline_carbon_t_per_ha: z.number().nonnegative(),
  root_shoot_ratio: z.number().positive(),
});
export type BlueCarbonProjectConfig = z.infer<typeof BlueCarbonProjectConfigSchema>;

// ──────────────────────────────── Output ──────────────────────────────

/**
 * Canonical oracle report. Field names deliberately match the on-chain
 * `Report` struct: `period_start`, `period_end`, `carbon_sequestered`,
 * `methodology` and `ipfs_evidence_hash`.
 */
export const OracleReportSchema = z
  .object({
    project_id: z.string().min(1),
    provider: z.string().min(1),
    methodology: z.string().min(1),
    period_start: isoDate,
    period_end: isoDate,
    carbon_sequestered: z.number().nonnegative(),
    confidence: z.number().min(0).max(1),
    ipfs_evidence_hash: z.string().min(1),
    evidence: z.record(z.string(), z.unknown()),
  })
  .refine((data) => data.period_start < data.period_end, {
    message: 'period_start must be strictly before period_end',
    path: ['period_end'],
  });
export type OracleReport = z.infer<typeof OracleReportSchema>;

/** Optional per-source evidence values hashed into `ipfs_evidence_hash`. */
export type ReportEvidence = {
  verra_report_ids?: string[];
  satellite_scene_count?: number;
  sensor_sample_count?: number;
  sensor_device_count?: number;
  blue_carbon_survey_count?: number;
  blue_carbon_habitat?: string;
  [key: string]: unknown;
};
