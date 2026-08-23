import { z } from 'zod';
import { createAxiosHttpClient, HttpClient } from './http';
import { buildOracleReport } from './report';
import {
  BlueCarbonProjectConfigSchema,
  BlueCarbonSurvey,
  BlueCarbonSurveyListSchema,
  METHODOLOGY,
} from './schemas';

const DEFAULT_BLUE_CARBON_URL =
  process.env.BLUE_CARBON_API_URL || 'https://api.bluecarbon-observatory.io/v1';

export interface BlueCarbonAdapterOptions {
  baseUrl?: string;
  http?: HttpClient;
  timeoutMs?: number;
}

export class BlueCarbonAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlueCarbonAdapterError';
  }
}

export class BlueCarbonSchemaError extends BlueCarbonAdapterError {
  constructor(source: string, issues: z.ZodIssue[]) {
    super(`Blue carbon response for ${source} failed schema validation: ${issues[0]?.message ?? 'unknown issue'}`);
    this.name = 'BlueCarbonSchemaError';
  }
}

export class BlueCarbonNoSurveysError extends BlueCarbonAdapterError {
  constructor(projectId: string, periodStart: string, periodEnd: string) {
    super(
      `No blue carbon surveys for project ${projectId} in period ${periodStart}..${periodEnd}`,
    );
    this.name = 'BlueCarbonNoSurveysError';
  }
}

// The C→CO2e conversion: 1 t C = 44/12 t CO2e (mass ratio of CO2 to atomic C).
const TONNES_C_TO_TONNES_CO2E = 44 / 12;
const KG_PER_TONNE = 1000;

/**
 * Mean total carbon stock (t C / ha) across the surveys in a period. Stock is
 * the sum of aboveground biomass, belowground biomass (derived from the
 * aboveground biomass via the project's root-to-shoot ratio) and soil organic
 * carbon.
 */
export function meanCarbonStockTonnesPerHa(
  surveys: BlueCarbonSurvey[],
  rootShootRatio: number,
): number {
  if (surveys.length === 0) return 0;
  const stocks = surveys.map(
    (survey) =>
      survey.aboveground_biomass_t_per_ha +
      survey.aboveground_biomass_t_per_ha * rootShootRatio +
      survey.belowground_biomass_t_per_ha +
      survey.soil_organic_carbon_t_per_ha,
  );
  return stocks.reduce((sum, stock) => sum + stock, 0) / stocks.length;
}

/**
 * Net carbon sequestration in kg CO2e for the period: the change in mean
 * carbon stock against the project baseline, scaled to the project area.
 */
export function carbonSequesteredKg(
  meanStockTonnesPerHa: number,
  baselineTonnesPerHa: number,
  areaHa: number,
): number {
  const deltaTonnesPerHa = meanStockTonnesPerHa - baselineTonnesPerHa;
  if (deltaTonnesPerHa < 0) return 0;
  return deltaTonnesPerHa * areaHa * TONNES_C_TO_TONNES_CO2E * KG_PER_TONNE;
}

/**
 * Aggregate blue carbon plot surveys for a coastal (mangrove, seagrass or
 * saltmarsh) project and produce an `OracleReport` with methodology
 * `BLUE-CARBON`.
 *
 * Upstream responses are validated against `BlueCarbonSurveyListSchema` before
 * any report is produced. Throws `BlueCarbonSchemaError`,
 * `BlueCarbonNoSurveysError`, or `BlueCarbonAdapterError` on the corresponding
 * failure paths.
 */
export async function aggregateBlueCarbonProject(
  project: {
    project_id: string;
    habitat: 'mangrove' | 'seagrass' | 'saltmarsh';
    area_ha: number;
    baseline_carbon_t_per_ha: number;
    root_shoot_ratio: number;
  },
  period: { periodStart: string; periodEnd: string },
  options: BlueCarbonAdapterOptions = {},
): Promise<ReturnType<typeof buildOracleReport>> {
  let validatedProject: z.infer<typeof BlueCarbonProjectConfigSchema>;
  try {
    validatedProject = BlueCarbonProjectConfigSchema.parse(project);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new BlueCarbonSchemaError('project config', error.issues);
    }
    throw error;
  }
  const baseUrl = (options.baseUrl || DEFAULT_BLUE_CARBON_URL).replace(/\/$/, '');
  const http = options.http ?? createAxiosHttpClient(options.timeoutMs);
  const { periodStart, periodEnd } = period;

  const response = await http.get<unknown>(
    `${baseUrl}/projects/${validatedProject.project_id}/surveys?start=${periodStart}&end=${periodEnd}`,
  );

  if (response.status < 200 || response.status >= 300) {
    throw new BlueCarbonAdapterError(
      `Blue carbon endpoint returned status ${response.status}`,
    );
  }

  let parsed: z.infer<typeof BlueCarbonSurveyListSchema>;
  try {
    parsed = BlueCarbonSurveyListSchema.parse(response.data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new BlueCarbonSchemaError('surveys', error.issues);
    }
    throw error;
  }

  const inPeriod = parsed.surveys.filter(
    (survey) => survey.survey_date >= periodStart && survey.survey_date <= periodEnd,
  );
  if (inPeriod.length === 0) {
    throw new BlueCarbonNoSurveysError(
      validatedProject.project_id,
      periodStart,
      periodEnd,
    );
  }

  const meanStock = meanCarbonStockTonnesPerHa(
    inPeriod,
    validatedProject.root_shoot_ratio,
  );
  const carbonSequestered = carbonSequesteredKg(
    meanStock,
    validatedProject.baseline_carbon_t_per_ha,
    validatedProject.area_ha,
  );

  return buildOracleReport({
    project_id: validatedProject.project_id,
    provider: 'BlueCarbonObservatory',
    methodology: METHODOLOGY.BLUE_CARBON,
    period_start: periodStart,
    period_end: periodEnd,
    carbon_sequestered: carbonSequestered,
    confidence: 0.8,
    evidence: {
      blue_carbon_survey_count: inPeriod.length,
      blue_carbon_habitat: validatedProject.habitat,
      mean_carbon_stock_t_per_ha: meanStock,
      baseline_carbon_t_per_ha: validatedProject.baseline_carbon_t_per_ha,
    },
  });
}
