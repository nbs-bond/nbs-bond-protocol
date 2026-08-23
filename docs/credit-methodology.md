# Credit Methodology

## Carbon Credit Calculation

credits_per_period = (carbon_sequestered_kg / 1000) * credit_conversion_factor

Where `credit_conversion_factor` is set at bond issuance per methodology:
- VERRA-VCS: 1.0 (standard)
- GOLD-STANDARD: 1.0
- ACR: 0.95 (conservative)
- CAR: 1.05 (includes buffer pool)

## Blue Carbon Credit Calculation

Blue carbon projects cover coastal ecosystems — mangroves, seagrass beds and
saltmarshes — that accumulate carbon at 3–5x the rate of terrestrial forests.

Per-plot carbon stock (t C / ha):

```
carbon_stock = aboveground_biomass
             + aboveground_biomass * root_shoot_ratio
             + belowground_biomass
             + soil_organic_carbon
```

Where `root_shoot_ratio` is the project-specific allometric constant (e.g. 0.8
for mangroves) used to derive additional belowground biomass. Net sequestration
over a reporting period:

```
delta_carbon_t_per_ha = mean(carbon_stock_t_per_ha) - baseline_carbon_t_per_ha
carbon_sequestered_kg = delta_carbon_t_per_ha * area_ha * (44 / 12) * 1000
```

- `baseline_carbon_t_per_ha` is fixed at project registration from the baseline survey.
- The `44 / 12` factor converts tonnes of carbon to tonnes of CO2e (mass ratio of CO2 to atomic C).
- Reports where the mean stock falls below baseline contribute zero credits (conservative, no discounting of prior periods).

### `root_shoot_ratio` (required)

`root_shoot_ratio` is a **required** field in `BlueCarbonProjectConfigSchema`.
Project configurations that omit it fail schema validation with a
`BlueCarbonSchemaError`.

The ratio is used to estimate belowground biomass from aboveground biomass:

```
belowground_biomass = aboveground_biomass × root_shoot_ratio
```

Project developers must select a value appropriate to their ecosystem and
methodology. The IPCC Wetlands Supplement (2013) provides the following
indicative ranges (not universal constants):

| Ecosystem     | Typical `root_shoot_ratio` range |
|---------------|----------------------------------|
| Mangroves     | 0.49 – 1.0                       |
| Seagrass      | varies by species/system          |
| Saltmarsh     | ~0.5 – 3.0                       |

Always refer to the project's approved methodology and the IPCC Wetlands
Supplement for ecosystem-specific guidance.

## Biodiversity Credit Calculation

Biodiversity credits are calculated using project-specific metrics:
- Habitat hectares restored
- Species Abundance Index (SAI) improvement
- Biodiversity Unit (UK BNG methodology)

On-chain, metrics are carried by a report as `BiodiversityMetrics` and converted
with integer-fixed-point rates (100% = `1_000_000`):

credits = ( habitat_ha * 1_000_000 + species_abundance * 100_000 + biodiversity_units * 1_000_000 ) / 1_000_000

## Credit Type Allocation (CouponEngine)

The bond's `credit_type` (Carbon | Biodiversity | Basket) determines how a report
is converted into distributable credits:

- **Carbon**: `credits = carbon_sequestered_kg / 1_000`
- **Biodiversity**: `credits = biodiversity_credit_calculation(metrics)`; requires metrics present
- **Basket**: both are computed, and holders accrue carbon and biodiversity credits
  **separately** (queryable via `accrued_credits_by_type`) plus a combined total

## Oracle Data Sources
- Accredited Auditors: annual baseline verification
- Satellite Imagery: monthly NDVI/biomass proxy
- IoT Sensors: continuous soil carbon/moisture
- Blue Carbon Surveys: seasonal plot-level biomass and soil carbon (mangrove, seagrass, saltmarsh)
- Community Monitors: quarterly species surveys
