import {
  fetchNdviData,
  ingestSatelliteMeasurement,
  calculateBiomassChange,
  estimateCarbonSequestration,
  SatelliteSchemaError,
  SatelliteNoUsableScenesError,
  SatelliteAdapterError,
  SatelliteProjectConfig,
} from './satellite-processor';
import { MockHttpClient } from './test-helpers';

const BASE_URL = 'https://api.satellite-processor.io/v1';

const SCENES = [
  {
    scene_id: 'S2A_20250212',
    capture_date: '2025-02-12',
    source: 'sentinel-2',
    cloud_cover: 4.2,
    ndvi_mean: 0.42,
    ndwi_mean: 0.11,
  },
  {
    scene_id: 'S2A_20250305',
    capture_date: '2025-03-05',
    source: 'sentinel-2',
    cloud_cover: 12.8,
    ndvi_mean: 0.46,
    ndwi_mean: 0.14,
  },
  {
    scene_id: 'L8_20250320',
    capture_date: '2025-03-20',
    source: 'landsat-8',
    cloud_cover: 55.0,
    ndvi_mean: 0.9,
  },
];

const PROJECT: SatelliteProjectConfig = {
  project_id: 'VCS-1234',
  bbox: [-76.5, -6.2, -76.2, -5.9],
  area_ha: 1250,
  baseline_ndvi: 0.28,
  // Tropical moist forest value, IPCC 2006 GHG Guidelines Vol. 4 Table 4.7 —
  // arbitrary for test purposes, but every test project must supply one.
  ndvi_carbon_factor_t_per_ha: 3.67,
};

const PERIOD = { periodStart: '2025-01-01', periodEnd: '2025-03-31' };

describe('calculateBiomassChange', () => {
  it('returns zero when NDVI does not improve on the baseline', () => {
    expect(calculateBiomassChange(0.5, 0.4)).toBe(0);
  });

  it('is positive when NDVI improves on the baseline', () => {
    expect(calculateBiomassChange(0.28, 0.44)).toBeGreaterThan(0);
  });
});

describe('estimateCarbonSequestration', () => {
  it('returns kg CO2e scaled by area, NDVI change, and the supplied biomass factor', () => {
    const area = 100;
    const change = 0.1;
    const biomassFactor = 3.67;
    const expected = area * change * biomassFactor * (44 / 12) * 1000;
    expect(estimateCarbonSequestration(area, change, biomassFactor)).toBeCloseTo(expected);
  });

  it('scales linearly with the biomass factor, so a different per-project factor changes the result', () => {
    const area = 100;
    const change = 0.1;
    const lowBiomassFactor = 1.0; // e.g. savanna/grassland
    const highBiomassFactor = 7.5; // e.g. dense tropical forest

    const low = estimateCarbonSequestration(area, change, lowBiomassFactor);
    const high = estimateCarbonSequestration(area, change, highBiomassFactor);

    expect(high).toBeGreaterThan(low);
    expect(high).toBeCloseTo(low * (highBiomassFactor / lowBiomassFactor));
  });
});

describe('fetchNdviData', () => {
  it('validates scenes returned by the upstream endpoint', async () => {
    const http = new MockHttpClient([{ status: 200, data: { scenes: SCENES } }]);
    const scenes = await fetchNdviData(
      '-76.5,-6.2,-76.2,-5.9',
      '2025-01-01',
      '2025-03-31',
      { baseUrl: BASE_URL, http },
    );
    expect(scenes).toHaveLength(3);
    expect(http.calls[0].url).toContain('/ndvi/stats?bbox=');
  });

  it('throws SatelliteSchemaError on a malformed scene', async () => {
    const http = new MockHttpClient([
      { status: 200, data: { scenes: [{ ...SCENES[0], ndvi_mean: 2.5 }] } },
    ]);
    await expect(
      fetchNdviData('-76.5,-6.2,-76.2,-5.9', '2025-01-01', '2025-03-31', {
        baseUrl: BASE_URL,
        http,
      }),
    ).rejects.toBeInstanceOf(SatelliteSchemaError);
  });

  it('throws SatelliteAdapterError on a non-2xx response', async () => {
    const http = new MockHttpClient([{ status: 503, data: {} }]);
    await expect(
      fetchNdviData('-76.5,-6.2,-76.2,-5.9', '2025-01-01', '2025-03-31', {
        baseUrl: BASE_URL,
        http,
      }),
    ).rejects.toBeInstanceOf(SatelliteAdapterError);
  });
});

describe('ingestSatelliteMeasurement', () => {
  it('produces a validated REMOTE-SENSING report with evidence hash', async () => {
    const http = new MockHttpClient([{ status: 200, data: { scenes: SCENES } }]);
    const report = await ingestSatelliteMeasurement(PROJECT, PERIOD, { baseUrl: BASE_URL, http });

    expect(report.project_id).toBe('VCS-1234');
    expect(report.methodology).toBe('REMOTE-SENSING');
    expect(report.period_start).toBe('2025-01-01');
    expect(report.period_end).toBe('2025-03-31');
    expect(report.ipfs_evidence_hash).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
    expect(report.evidence.satellite_scene_count).toBe(2);
    expect(report.carbon_sequestered).toBeGreaterThan(0);
  });

  it('uses the project-configured biomass factor rather than a fixed constant', async () => {
    const http1 = new MockHttpClient([{ status: 200, data: { scenes: SCENES } }]);
    const http2 = new MockHttpClient([{ status: 200, data: { scenes: SCENES } }]);

    const lowFactorProject = { ...PROJECT, ndvi_carbon_factor_t_per_ha: 1.0 };
    const highFactorProject = { ...PROJECT, ndvi_carbon_factor_t_per_ha: 7.5 };

    const lowReport = await ingestSatelliteMeasurement(lowFactorProject, PERIOD, {
      baseUrl: BASE_URL,
      http: http1,
    });
    const highReport = await ingestSatelliteMeasurement(highFactorProject, PERIOD, {
      baseUrl: BASE_URL,
      http: http2,
    });

    // Same scenes, same NDVI change -> the only thing driving the difference
    // in carbon_sequestered is the per-project factor, proving it's actually
    // read from config rather than a hardcoded default.
    expect(highReport.carbon_sequestered).toBeGreaterThan(lowReport.carbon_sequestered);
    expect(highReport.carbon_sequestered).toBeCloseTo(lowReport.carbon_sequestered * 7.5);
  });

  it('throws SatelliteNoUsableScenesError when all scenes exceed cloud cover', async () => {
    const http = new MockHttpClient([
      {
        status: 200,
        data: { scenes: [{ ...SCENES[0], cloud_cover: 95 }] },
      },
    ]);
    await expect(
      ingestSatelliteMeasurement(PROJECT, PERIOD, { baseUrl: BASE_URL, http }),
    ).rejects.toBeInstanceOf(SatelliteNoUsableScenesError);
  });

  it('throws SatelliteNoUsableScenesError when scenes fall outside the period', async () => {
    const http = new MockHttpClient([
      {
        status: 200,
        data: { scenes: [{ ...SCENES[0], capture_date: '2024-12-01' }] },
      },
    ]);
    await expect(
      ingestSatelliteMeasurement(PROJECT, PERIOD, { baseUrl: BASE_URL, http }),
    ).rejects.toBeInstanceOf(SatelliteNoUsableScenesError);
  });

  it('rejects an invalid project configuration', async () => {
    const http = new MockHttpClient([{ status: 200, data: { scenes: SCENES } }]);
    await expect(
      ingestSatelliteMeasurement(
        { ...PROJECT, area_ha: -5 },
        PERIOD,
        { baseUrl: BASE_URL, http },
      ),
    ).rejects.toThrow();
  });

  it('fails loudly instead of silently defaulting when ndvi_carbon_factor_t_per_ha is omitted', async () => {
    const http = new MockHttpClient([{ status: 200, data: { scenes: SCENES } }]);
    const { ndvi_carbon_factor_t_per_ha, ...projectMissingFactor } = PROJECT;

    await expect(
      ingestSatelliteMeasurement(
        projectMissingFactor as SatelliteProjectConfig,
        PERIOD,
        { baseUrl: BASE_URL, http },
      ),
    ).rejects.toThrow();
  });

  it('rejects a non-positive ndvi_carbon_factor_t_per_ha', async () => {
    const http = new MockHttpClient([{ status: 200, data: { scenes: SCENES } }]);
    await expect(
      ingestSatelliteMeasurement(
        { ...PROJECT, ndvi_carbon_factor_t_per_ha: 0 },
        PERIOD,
        { baseUrl: BASE_URL, http },
      ),
    ).rejects.toThrow();
  });
});