import {
  aggregateBlueCarbonProject,
  meanCarbonStockTonnesPerHa,
  carbonSequesteredKg,
  BlueCarbonAdapterError,
  BlueCarbonNoSurveysError,
  BlueCarbonSchemaError,
} from './blue-carbon-adapter';
import { MockHttpClient } from './test-helpers';

const BASE_URL = 'https://api.bluecarbon-observatory.io/v1';

const SURVEYS = [
  {
    survey_id: 'BC-001',
    survey_date: '2025-02-10',
    habitat: 'mangrove',
    plot_area_ha: 1.0,
    aboveground_biomass_t_per_ha: 85,
    belowground_biomass_t_per_ha: 60,
    soil_organic_carbon_t_per_ha: 420,
  },
  {
    survey_id: 'BC-002',
    survey_date: '2025-03-15',
    habitat: 'mangrove',
    plot_area_ha: 1.0,
    aboveground_biomass_t_per_ha: 91,
    belowground_biomass_t_per_ha: 64,
    soil_organic_carbon_t_per_ha: 431,
  },
];

const PROJECT = {
  project_id: 'BLUE-2024-001',
  habitat: 'mangrove' as const,
  area_ha: 500,
  baseline_carbon_t_per_ha: 480,
  root_shoot_ratio: 0.8,
};

const PERIOD = { periodStart: '2025-01-01', periodEnd: '2025-03-31' };

describe('meanCarbonStockTonnesPerHa', () => {
  it('sums aboveground, belowground-derived and soil organic carbon', () => {
    const stock = meanCarbonStockTonnesPerHa(SURVEYS as any, 0.8);
    const expected = ((85 + 85 * 0.8 + 60 + 420) + (91 + 91 * 0.8 + 64 + 431)) / 2;
    expect(stock).toBeCloseTo(expected);
  });
});

describe('carbonSequesteredKg', () => {
  it('converts the baseline delta into kg CO2e across the project area', () => {
    const kg = carbonSequesteredKg(640, 480, 500);
    const expected = (640 - 480) * 500 * (44 / 12) * 1000;
    expect(kg).toBeCloseTo(expected);
  });

  it('returns 0 when the stock is below baseline', () => {
    expect(carbonSequesteredKg(400, 480, 500)).toBe(0);
  });
});

describe('aggregateBlueCarbonProject', () => {
  it('produces a validated BLUE-CARBON report with evidence hash', async () => {
    const http = new MockHttpClient([{ status: 200, data: { surveys: SURVEYS } }]);
    const report = await aggregateBlueCarbonProject(PROJECT, PERIOD, {
      baseUrl: BASE_URL,
      http,
    });

    expect(report.project_id).toBe('BLUE-2024-001');
    expect(report.methodology).toBe('BLUE-CARBON');
    expect(report.period_start).toBe('2025-01-01');
    expect(report.period_end).toBe('2025-03-31');
    expect(report.ipfs_evidence_hash).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
    expect(report.evidence.blue_carbon_survey_count).toBe(2);
    expect(report.evidence.blue_carbon_habitat).toBe('mangrove');
    expect(report.carbon_sequestered).toBeCloseTo(
      carbonSequesteredKg(
        meanCarbonStockTonnesPerHa(SURVEYS as any, PROJECT.root_shoot_ratio),
        PROJECT.baseline_carbon_t_per_ha,
        PROJECT.area_ha,
      ),
    );
  });

  it('throws BlueCarbonNoSurveysError when no surveys fall inside the period', async () => {
    const http = new MockHttpClient([
      {
        status: 200,
        data: {
          surveys: [{ ...SURVEYS[0], survey_date: '2024-11-30' }],
        },
      },
    ]);
    await expect(
      aggregateBlueCarbonProject(PROJECT, PERIOD, { baseUrl: BASE_URL, http }),
    ).rejects.toBeInstanceOf(BlueCarbonNoSurveysError);
  });

  it('throws BlueCarbonSchemaError when a survey violates the schema', async () => {
    const http = new MockHttpClient([
      {
        status: 200,
        data: {
          surveys: [{ ...SURVEYS[0], habitat: 'peatland' }],
        },
      },
    ]);
    await expect(
      aggregateBlueCarbonProject(PROJECT, PERIOD, { baseUrl: BASE_URL, http }),
    ).rejects.toBeInstanceOf(BlueCarbonSchemaError);
  });

  it('throws BlueCarbonAdapterError on a non-2xx upstream response', async () => {
    const http = new MockHttpClient([{ status: 500, data: {} }]);
    await expect(
      aggregateBlueCarbonProject(PROJECT, PERIOD, { baseUrl: BASE_URL, http }),
    ).rejects.toBeInstanceOf(BlueCarbonAdapterError);
  });

  it('rejects an invalid project configuration', async () => {
    const http = new MockHttpClient([{ status: 200, data: { surveys: SURVEYS } }]);
    await expect(
      aggregateBlueCarbonProject(
        { ...PROJECT, area_ha: -1 },
        PERIOD,
        { baseUrl: BASE_URL, http },
      ),
    ).rejects.toThrow();
  });

  it('throws BlueCarbonSchemaError when root_shoot_ratio is missing', async () => {
    const http = new MockHttpClient([{ status: 200, data: { surveys: SURVEYS } }]);
    const { root_shoot_ratio: _, ...projectWithoutRatio } = PROJECT;
    await expect(
      aggregateBlueCarbonProject(
        projectWithoutRatio as any,
        PERIOD,
        { baseUrl: BASE_URL, http },
      ),
    ).rejects.toBeInstanceOf(BlueCarbonSchemaError);
  });

  it('calculates belowground biomass using the configured root_shoot_ratio', () => {
    const surveys = [
      {
        survey_id: 'S1',
        survey_date: '2025-02-10',
        habitat: 'mangrove' as const,
        plot_area_ha: 1.0,
        aboveground_biomass_t_per_ha: 100,
        belowground_biomass_t_per_ha: 50,
        soil_organic_carbon_t_per_ha: 200,
      },
    ];
    const ratio = 0.75;
    const stock = meanCarbonStockTonnesPerHa(surveys, ratio);
    const expected = 100 + 100 * ratio + 50 + 200;
    expect(stock).toBeCloseTo(expected);
  });

  it('does not silently produce zero belowground biomass when ratio is omitted', async () => {
    const http = new MockHttpClient([{ status: 200, data: { surveys: SURVEYS } }]);
    const { root_shoot_ratio: _, ...projectWithoutRatio } = PROJECT;
    let threw = false;
    try {
      await aggregateBlueCarbonProject(
        projectWithoutRatio as any,
        PERIOD,
        { baseUrl: BASE_URL, http },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
