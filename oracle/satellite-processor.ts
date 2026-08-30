import { z } from 'zod';
import { createAxiosHttpClient, HttpClient } from './http';
import { buildOracleReport } from './report';
import {
  SatelliteSceneSchema,
  SatelliteSceneListSchema,
  SatelliteProjectConfig,
  SatelliteProjectConfigSchema,
  SatelliteScene,
  METHODOLOGY,
} from './schemas';


export {
  SatelliteProjectConfig,
  METHODOLOGY,

} from './schemas';

const DEFAULT_SATELLITE_URL = process.env.SATELLITE_API_URL || 'https://api.satellite-processor.io/v1';

export interface SatelliteAdapterOptions {
  baseUrl?: string;
  bearerToken?: string;
  http?: HttpClient;
  timeoutMs?: number;
  /** Maximum cloud cover (%) for a scene to be considered usable. */
  maxCloudCover?: number;
}

export class SatelliteAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SatelliteAdapterError';
  }
}

export class SatelliteSchemaError extends SatelliteAdapterError {
  constructor(source: string, issues: z.ZodIssue[]) {
    super(`Satellite response for ${source} failed schema validation: ${issues[0]?.message ?? 'unknown issue'}`);
    this.name = 'SatelliteSchemaError';
  }
}

export class SatelliteNoUsableScenesError extends SatelliteAdapterError {
  constructor(periodStart: string, periodEnd: string, maxCloudCover: number) {
    super(
      `No usable satellite scenes (cloud cover <= ${maxCloudCover}%) for period ${periodStart}..${periodEnd}`,
    );
    this.name = 'SatelliteNoUsableScenesError';
  }
}

/**
 * Query a Sentinel-2 / Landsat NDVI stats endpoint for the given bounding box
 * and period. Every returned scene is validated against `SatelliteSceneSchema`.
 */
export async function fetchNdviData(
  bbox: string,
  startDate: string,
  endDate: string,
  options: SatelliteAdapterOptions = {},
): Promise<SatelliteScene[]> {
  const baseUrl = (options.baseUrl || DEFAULT_SATELLITE_URL).replace(/\/$/, '');
  const http = options.http ?? createAxiosHttpClient(options.timeoutMs);
  const headers = options.bearerToken ? { Authorization: `Bearer ${options.bearerToken}` } : undefined;

  const response = await http.get<unknown>(
    `${baseUrl}/ndvi/stats?bbox=${encodeURIComponent(bbox)}&start=${startDate}&end=${endDate}`,
    { headers },
  );

  if (response.status < 200 || response.status >= 300) {
    throw new SatelliteAdapterError(
      `Satellite endpoint returned status ${response.status} for bbox ${bbox}`,
    );
  }

  let parsed: z.infer<typeof SatelliteSceneListSchema>;
  try {
    parsed = SatelliteSceneListSchema.parse(response.data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new SatelliteSchemaError('ndvi/stats', error.issues);
    }
    throw error;
  }

  for (const scene of parsed.scenes) {
    SatelliteSceneSchema.parse(scene);
  }
  return parsed.scenes;
}

/**
 * Fractional vegetation-cover proxy derived from a change in NDVI.
 * Returns a value in [0, 1] (0 = no improvement over baseline).
 */
export function calculateBiomassChange(ndviBaseline: number, ndviCurrent: number): number {
  const fractionalCover = (ndviCurrent - ndviBaseline) / (1 - ndviBaseline);
  return Math.max(0, fractionalCover);
}

const TONNES_C_TO_KG_CO2E = (44 / 12) * 1000;

/**
 * Estimate carbon sequestration in kg CO2e.
 *
 * Simplified IPCC Tier 1: `area_ha * ndvi_change * biomass_factor`, where
 * `biomassFactorTPerHa` is tonnes of carbon per hectare per unit NDVI
 * change. This is a per-project scalar simplification of Tier 1 biomass
 * expansion factors, which properly vary by forest type, ecozone, and
 * canopy cover fraction (see IPCC 2006 Guidelines for National Greenhouse
 * Gas Inventories, Vol. 4 (AFOLU), Ch. 4, Table 4.7). It must come from
 * `SatelliteProjectConfig.ndvi_carbon_factor_t_per_ha` — see that field's
 * doc comment for why there is no built-in default. Tier 2/3 methodology
 * is out of scope here.
 */
export function estimateCarbonSequestration(
  areaHa: number,
  ndviChange: number,
  biomassFactorTPerHa: number,
): number {
  return areaHa * ndviChange * biomassFactorTPerHa * TONNES_C_TO_KG_CO2E;
}

function withinPeriod(scene: SatelliteScene, periodStart: string, periodEnd: string): boolean {
  return scene.capture_date >= periodStart && scene.capture_date <= periodEnd;
}

/**
 * Ingest NDVI imagery for a project's bounding box, compute the mean NDVI
 * over the period, compare against the project baseline, and produce an
 * `OracleReport` with a methodology `REMOTE-SENSING`.
 */
export async function ingestSatelliteMeasurement(
  project: SatelliteProjectConfig,
  period: { periodStart: string; periodEnd: string },
  options: SatelliteAdapterOptions = {},
): Promise<ReturnType<typeof buildOracleReport>> {
  const validatedProject = SatelliteProjectConfigSchema.parse(project);
  const maxCloudCover = options.maxCloudCover ?? 20;
  const { periodStart, periodEnd } = period;

  const scenes = await fetchNdviData(
    validatedProject.bbox.join(','),
    periodStart,
    periodEnd,
    options,
  );

  const usable = scenes.filter(
    (scene) => scene.cloud_cover <= maxCloudCover && withinPeriod(scene, periodStart, periodEnd),
  );
  if (usable.length === 0) {
    throw new SatelliteNoUsableScenesError(periodStart, periodEnd, maxCloudCover);
  }

    const meanNdvi =
      usable.reduce((sum, scene) => sum + scene.ndvi_mean, 0) / usable.length;
        const ndviChange = calculateBiomassChange(validatedProject.baseline_ndvi, meanNdvi);
        const carbonSequestered = estimateCarbonSequestration(
        validatedProject.area_ha,
        ndviChange,
        validatedProject.ndvi_carbon_factor_t_per_ha,
    );

    return buildOracleReport({
      project_id: validatedProject.project_id,
      provider: 'SatelliteProcessor',
      methodology: METHODOLOGY.REMOTE_SENSING,
      period_start: periodStart,
      period_end: periodEnd,
      carbon_sequestered: carbonSequestered,
      confidence: 0.85,
      evidence: {
        satellite_scene_count: usable.length,
        mean_ndvi: meanNdvi,
        ndvi_change: ndviChange,
        mean_ndwi: meanOfDefined(usable.map((scene) => scene.ndwi_mean)),
        sources: [...new Set(usable.map((scene) => scene.source))],
      },
    });
}

function meanOfDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  if (defined.length === 0) return undefined;
  return defined.reduce((sum, value) => sum + value, 0) / defined.length;
}

export {SatelliteProjectConfigSchema};