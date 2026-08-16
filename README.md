<div align="center">

# 🌍 NbS Bond Protocol

### *Tokenized Nature-based Solution Bonds on Stellar*

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/your-org/nbs-bond-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/nbs-bond-protocol/actions/workflows/ci.yml)
[![Built on Stellar](https://img.shields.io/badge/Built%20on-Stellar-7B68EE)](https://stellar.org)
[![Soroban](https://img.shields.io/badge/Contracts-Soroban%20%7C%20Rust-orange)](https://soroban.stellar.org)
[![NestJS](https://img.shields.io/badge/API-NestJS-red)](https://nestjs.com)
[![Angular](https://img.shields.io/badge/Frontend-Angular-DD0031)](https://angular.io)
[![IPFS](https://img.shields.io/badge/Storage-IPFS-65C2CB)](https://ipfs.tech)
[![Contract Count](https://img.shields.io/badge/Contracts-6-blue)](https://github.com/your-org/nbs-bond-protocol)
[![Test Coverage](https://img.shields.io/badge/Coverage-Pending-yellow)](https://github.com/your-org/nbs-bond-protocol)

> **Redefining green finance** — where bond interest is paid in carbon and biodiversity credits,  
> every tranche backs a living ecosystem, and DeFi unlocks liquidity for the planet.

[Overview](#-overview) • [How It Works](#-how-it-works) • [Architecture](#-architecture) • [Tech Stack](#-tech-stack) • [Smart Contracts](#-smart-contract-design) • [Getting Started](#-getting-started) • [Roadmap](#-roadmap)

---

</div>

## 📌 Table of Contents

- [Overview](#-overview)
- [Why This Exists](#-why-this-exists)
- [Core Concepts](#-core-concepts)
- [How It Works](#-how-it-works)
- [Key Features](#-key-features)
- [Architecture](#-architecture)
- [Tech Stack](#-tech-stack)
- [Smart Contract Design](#-smart-contract-design)
- [Oracle & Project Performance](#-oracle--project-performance)
- [Credit Types Supported](#-credit-types-supported)
- [Secondary Market](#-secondary-market)
- [Security Model](#-security-model)
- [Relationship to CarbonChain](#-relationship-to-carbonchain)
- [Getting Started](#-getting-started)
- [Environment Variables](#-environment-variables)
- [Project Structure](#-project-structure)
- [API Reference](#-api-reference)
- [Testing](#-testing)
- [Deployment](#-deployment)
- [Governance](#-governance)
- [Compliance & KYC](#-compliance--kyc)
- [Roadmap](#-roadmap)
- [Contributing](#-contributing)
- [Security Disclosure](#-security-disclosure)
- [License](#-license)
- [Acknowledgements](#-acknowledgements)

---

## 🌿 Overview

**NbS Bond Protocol** is a blockchain-native green finance instrument built on the [Stellar](https://stellar.org) network. It issues bonds where **coupon payments are denominated in carbon credits and biodiversity credits** rather than fiat currency — directly linking investor returns to the ecological performance of real-world nature-based projects.

Each bond tranche is backed by a specific, verifiable reforestation, blue carbon (mangrove, seagrass, wetland), or biodiversity restoration project. Smart contracts automate the entire bond lifecycle, while on-chain oracles provide tamper-resistant proof of carbon stock growth.

This is not merely a carbon offset product. It is a **financial primitive** — a programmable, tradeable, yield-bearing instrument whose yield is the planet healing. It combines the structural familiarity of traditional fixed-income instruments with the transparency, composability, and accessibility of decentralized finance.

### At a Glance

| Property | Value |
|---|---|
| **Blockchain** | Stellar (Soroban) |
| **Smart Contract Language** | Rust |
| **Coupon Currency** | Carbon Credits / Biodiversity Credits |
| **Bond Type** | Nature-based Solution (NbS) |
| **Secondary Market** | Stellar DEX |
| **Document Storage** | IPFS |
| **Oracle Type** | Multi-source (Auditor + Satellite + IoT) |
| **Minimum Investment** | Fractional (no floor) |
| **Target Projects** | Reforestation, Blue Carbon, Biodiversity Corridors |

---

## 🔍 Why This Exists

### The Problem with Green Finance Today

The global voluntary carbon market exceeded **$2 billion** in 2023 and is projected to reach **$50 billion by 2030**. Yet the infrastructure underpinning it is plagued by:

- **Opacity** — Investors cannot trace the direct link between their capital and specific ecological outcomes
- **Illiquidity** — Traditional green bonds lock capital for 5–20 years with no meaningful secondary market
- **Integrity failures** — High-profile greenwashing scandals have eroded trust in carbon credits
- **Access barriers** — Minimum investment sizes ($100,000+) exclude retail and emerging-market investors
- **Settlement friction** — Manual credit verification and distribution creates costly delays

### What NbS Bond Protocol Changes

| Problem | Our Solution |
|---|---|
| Carbon credit integrity is hard to verify | On-chain oracle anchors real project measurements |
| Green bonds lack coupon-to-impact traceability | Each tranche is 1:1 backed by a single, named project |
| Bond coupons are illiquid for retail holders | Stellar DEX enables permissionless secondary trading |
| Manual settlement is costly and slow | Soroban contracts automate the full lifecycle |
| Greenwashing is rampant | IPFS-anchored audit trails are permanent and public |
| Access is limited to institutions | Tokenization allows fractional ownership from any wallet |

### Our Thesis

> Nature-based solutions represent the single largest untapped carbon sink on Earth. Mobilizing private capital toward them at scale requires instruments that are **credible, liquid, and programmable**. NbS Bond Protocol is that instrument.

---

## 📚 Core Concepts

### What is a Nature-based Solution (NbS)?

Nature-based Solutions are actions that protect, sustainably manage, or restore natural ecosystems while simultaneously providing human well-being and biodiversity benefits. For the purposes of this protocol, NbS projects include:

- **Reforestation & Afforestation** — Planting native tree species on degraded or deforested land
- **Blue Carbon** — Conserving or restoring coastal ecosystems (mangroves, seagrass beds, saltmarshes) that sequester carbon at rates 3–5x higher than terrestrial forests
- **Avoided Deforestation (REDD+)** — Protecting standing forests from conversion
- **Biodiversity Corridors** — Restoring habitat connectivity to support species migration
- **Regenerative Agriculture** — Transitioning farmland to practices that build soil organic carbon

### What is a Carbon Credit?

A single carbon credit represents **one metric tonne of CO₂ equivalent** (tCO₂e) either sequestered from the atmosphere or prevented from being emitted. In NbS Bond Protocol, carbon credits issued as Stellar Assets are:

- Minted by the `CouponEngine` contract upon verified oracle reports
- Traceable to a specific project and measurement period
- Tradeable on the Stellar DEX
- Permanently retirable on-chain

### What is a Biodiversity Credit?

A biodiversity credit represents a **measurable, verifiable unit of biodiversity outcome** — such as a hectare of restored habitat, or a population increase of a threatened species. Biodiversity credits are an emerging asset class, and NbS Bond Protocol is architected to accommodate them alongside carbon credits as the market matures.

### Bond Tranche

A bond tranche is a discrete issuance with defined:
- **Face Value** (in XLM or USDC equivalent)
- **Maturity Date**
- **Coupon Schedule** (quarterly, semi-annual, annual)
- **Coupon Currency** (carbon credits, biodiversity credits, or a basket)
- **Backing Project** (a single NbS project registered on-chain)

---

## ⚙️ How It Works

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │                       NbS BOND LIFECYCLE                            │
  │                                                                      │
  │  ① REGISTRATION      ② ISSUANCE           ③ INVESTMENT             │
  │  Project developer   Bond issuer creates   Investors purchase       │
  │  registers NbS   →   tokenized tranche  →  bond tokens on          │
  │  project on-chain    backed by project      Stellar network         │
  │                                                                      │
  │  ④ MONITORING        ⑤ COUPON CALC         ⑥ DISTRIBUTION          │
  │  Oracle network      Smart contract         Carbon/biodiv           │
  │  feeds carbon    →   calculates earned  →   credits auto-          │
  │  stock data          credits per period      sent to wallets        │
  │                                                                      │
  │  ⑦ TRADING           ⑧ MATURITY            ⑨ RETIREMENT            │
  │  Bond tokens &       Principal returned,    Credits retired         │
  │  coupons traded  →   final credits      →   on-chain or held       │
  │  on Stellar DEX      settled                for compliance          │
  └──────────────────────────────────────────────────────────────────────┘
```

### Detailed Step-by-Step

#### Step 1 — Project Registration
A project developer submits project documentation (geospatial boundaries, ecological baseline, methodology, legal title) to IPFS. The content hash is registered with the `ProjectRegistry` contract on Stellar. An accredited auditor validates the baseline and co-signs the on-chain record.

#### Step 2 — Bond Tranche Issuance
A bond issuer (project developer, green bank, or SPV) calls `BondIssuer.issue_bond()` specifying the face value, coupon schedule, project backing, and credit type. The contract mints bond tokens and holds them in escrow pending investor subscriptions.

#### Step 3 — Investor Subscription
Investors connect their Stellar wallets, pass KYC (handled off-chain via the NestJS API), and purchase bond tokens. Each token represents a pro-rata claim on the tranche. Minimum subscription is one token (fractional NbS exposure).

#### Step 4 — Continuous Oracle Monitoring
The oracle network continuously monitors carbon stock growth via satellite imagery, IoT sensors, and periodic third-party audits. Signed measurement reports are submitted on-chain to the `OracleConsumer` contract. A report only becomes `Verified` after **independent sources** endorse it: each verify call is recorded on-chain and counted against a configurable signature threshold, and a provider can never verify its own report. This multi-source consensus makes fabricated measurements economically and cryptographically impractical.

#### Step 5 — Coupon Calculation
At each coupon date, the `CouponEngine` contract reads the verified oracle report **by its on-chain `report_id`** and calculates the total carbon credits earned by the project during that period. Reports that are not `Verified` are rejected, and the report's project must match the bond's registered project. Credits are allocated pro-rata to all bond token holders.

#### Step 6 — Automatic Distribution & Claiming
Coupon distribution runs entirely on-chain, referencing only reports that have passed multi-source verification, and records the `report_id` on-chain for full auditability. Accrued credits are claimed directly to the bondholder's wallet via `claim_credits()` (or the `POST /bonds/:id/claim` API). No manual intervention, no intermediary, no settlement delay.

#### Step 7 — Secondary Market Trading
At any point, investors may list bond tokens on the Stellar DEX. When an order is filled, the `DEXRouter` contract invokes `BondIssuer.transfer()` to move the tokens **on-chain from seller to buyer atomically** — the order status only updates after the token transfer succeeds, eliminating off-ledger settlement risk. Tokens can also be transferred peer-to-peer via `BondIssuer.transfer()` (or the `POST /bonds/:id/transfer` API). Price discovery happens permissionlessly, reflecting market views on project performance.

#### Step 8 — Maturity & Settlement
At maturity, the `BondIssuer` contract returns principal to bondholders and settles any remaining credits. The bond tranche is marked inactive and removed from the active registry.

#### Step 9 — Credit Retirement
Bondholders may retire their carbon credits on-chain, generating a permanent, verifiable retirement certificate. Retired credits are burned and recorded in the public ledger — usable for corporate net-zero reporting.

---

## ✨ Key Features

### 🔗 Smart Contract Bond Lifecycle
The entire bond lifecycle — issuance, coupon accrual, distribution, maturity, and redemption — is handled by Soroban smart contracts written in Rust. No intermediary, no manual settlement, no counterparty risk. Every state transition is a publicly visible, immutable ledger entry.

### 🌐 Oracle-Driven Performance Verification
An oracle network feeds real-world project data (carbon stock measurements, satellite imagery hashes, third-party audit reports) on-chain. Credit coupon amounts are dynamically calculated based on **actual ecological performance**, not projections. Under-performing projects yield fewer credits; outperforming ones reward bondholders generously.

### 💱 Native Secondary Market Liquidity
Bond tokens and individual credit coupon tokens are standard **Stellar Assets**, making them natively compatible with the Stellar DEX. No bridges, no wrapped assets, no additional smart contract risk — just native Stellar primitives trading in a permissionless marketplace.

### 🌱 Fractional Green Exposure
Tokenization allows **fractional ownership** of bond tranches, opening nature-based finance to retail investors who couldn't access traditional green bond minimums (often $100,000+). Any wallet, any size.

### 📄 IPFS-Backed Immutable Documentation
All project prospectuses, audit reports, satellite data, and legal documentation are stored on **IPFS** with content hashes anchored on-chain. Documents are permanent, tamper-proof, and publicly accessible — making greenwashing technically impossible.

### 🛰️ Multi-Source Oracle Architecture
Carbon stock data is sourced from multiple independent providers: certified auditors, satellite imagery processors, and IoT sensor networks. Multi-source consensus prevents single points of failure or manipulation.

### 🔐 Nonce-Based Replay Protection
All sensitive contract interactions are protected by nonce-based replay protection. Each signed transaction consumes a unique nonce, preventing double-spend attacks, replay attacks, and front-running across the protocol.

### 🌊 Blue Carbon Support
The protocol is purpose-built to support blue carbon projects — coastal ecosystems that sequester carbon at 3–5x the rate of terrestrial forests but have been chronically underfunded due to measurement complexity. NbS Bond Protocol's oracle architecture handles the unique measurement methodologies of blue carbon science.

### 🤝 CarbonChain Integration
Built as a composable layer on top of CarbonChain's existing credit infrastructure, the protocol reuses battle-tested oracle feeds, IPFS anchoring patterns, and DEX integrations — dramatically reducing time-to-market and smart contract surface area.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      FRONTEND (Angular)                         │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Investor   │  │   Project    │  │  DEX / Marketplace   │  │
│  │  Dashboard   │  │  Registry    │  │     Interface        │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP / WebSocket
┌──────────────────────────▼──────────────────────────────────────┐
│                      API LAYER (NestJS)                         │
│                                                                 │
│  ┌────────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐  │
│  │   Bond     │  │  Oracle  │  │   KYC /  │  │ Marketplace │  │
│  │ Management │  │  Feeds   │  │   Auth   │  │   Router    │  │
│  └────────────┘  └──────────┘  └──────────┘  └─────────────┘  │
└────────┬──────────────────────────────────────────┬────────────┘
         │ Stellar SDK / Horizon                    │ IPFS HTTP API
┌────────▼──────────────────────────┐  ┌────────────▼────────────┐
│        STELLAR BLOCKCHAIN         │  │      IPFS NETWORK        │
│                                   │  │                          │
│  ┌─────────────────────────────┐  │  │  - Project prospectus    │
│  │      SOROBAN CONTRACTS      │  │  │  - Audit reports         │
│  │                             │  │  │  - Satellite imagery     │
│  │  BondIssuer                 │  │  │    hashes                │
│  │  CouponEngine               │  │  │  - Legal documentation   │
│  │  OracleConsumer             │  │  │  - Methodology docs      │
│  │  DEXRouter                  │  │  └──────────────────────────┘
│  │  ProjectRegistry            │  │
│  │  CreditRetirement           │  │  ┌──────────────────────────┐
│  └─────────────────────────────┘  │  │     ORACLE NETWORK       │
│                                   │◄─│                          │
│  Stellar DEX (CLMM + Order Book)  │  │  - Verra / Gold Standard │
│  XLM / USDC / Credit pairs        │  │  - Satellite processors  │
└───────────────────────────────────┘  │  - IoT sensor networks   │
                                       └──────────────────────────┘
```

### Data Flow

```
Project Data (IPFS) ──► OracleConsumer ──► CouponEngine ──► BondholderWallet
     │                        │                  │
     │                  Measurement           Credit
     │                   Reports              Tokens
     │
ProjectRegistry ──► BondIssuer ──► Bond Tokens ──► Stellar DEX
```

---

## 🧰 Tech Stack

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| **Smart Contracts** | Soroban (Rust) | latest | Bond lifecycle, credit distribution, replay protection |
| **Backend API** | NestJS | v10+ | Business logic, oracle integration, KYC/auth |
| **Frontend** | Angular | v17+ | Investor dashboard, project registry, DEX UI |
| **Off-chain Storage** | IPFS / Pinata | — | Project docs, audit trails, satellite data |
| **Marketplace** | Stellar DEX | — | Secondary trading of bond tokens & credit coupons |
| **Security** | Nonce-based replay protection | — | Prevent double-spend and replay attacks |
| **Blockchain** | Stellar Network | — | Settlement, tokenization, decentralized exchange |
| **Credit Infrastructure** | CarbonChain | — | Underlying carbon credit registry and oracle feeds |
| **Testing (Contracts)** | `soroban-sdk` test harness | — | Unit & integration tests for Rust contracts |
| **Testing (API)** | Jest + Supertest | — | API endpoint testing |
| **Testing (Frontend)** | Jasmine + Karma | — | Angular component testing |
| **CI/CD** | GitHub Actions | — | Automated build, test, and deploy pipeline |

---

## 📜 Smart Contract Design

The protocol is composed of six primary Soroban contracts deployed on Stellar:

---

### `BondIssuer`

Handles bond creation, tranche configuration, and investor token minting. The issuer contract is the entry point for all new bond tranches.

```rust
// Bond configuration structure
#[derive(Clone)]
#[contracttype]
pub struct BondConfig {
    pub project_id: BytesN<32>,      // IPFS content hash of project docs
    pub face_value: i128,            // In stroops (XLM) or USDC
    pub coupon_schedule: Vec<u64>,   // Unix timestamps for each coupon date
    pub credit_type: CreditType,     // Carbon | Biodiversity | Basket
    pub maturity_date: u64,
    pub total_supply: i128,          // Total bond tokens to mint
}

// Issue a new bond tranche
pub fn issue_bond(
    env: Env,
    issuer: Address,
    config: BondConfig,
) -> BondId { ... }

// Investor subscribes to a tranche
pub fn subscribe(
    env: Env,
    investor: Address,
    bond_id: BondId,
    amount: i128,
    nonce: u64,
) -> Result<(), BondError> { ... }
```

Maturity is **time-based**: `mature_bond` is rejected before the bond's `maturity_date` is reached, and once that date elapses `subscribe` and `transfer` are also rejected so the outstanding supply is frozen on schedule. Redemption still requires the explicit `Matured` state.

---

### `CouponEngine`

Calculates and distributes credit coupons to bondholders based on oracle-reported performance data. The engine reads verified measurement reports and converts raw carbon stock growth figures into distributable credit tokens.

```rust
// Oracle measurement report (signed by approved data provider)
#[derive(Clone)]
#[contracttype]
pub struct OracleReport {
    pub project_id: BytesN<32>,
    pub period_start: u64,
    pub period_end: u64,
    pub carbon_sequestered: i128,    // In kg CO2e
    pub biodiversity: BiodiversityMetrics,
    pub methodology: Symbol,
    pub provider_signature: BytesN<64>,
    pub ipfs_evidence_hash: BytesN<32>,
}

// Optional biodiversity metrics attached to a report
#[derive(Clone)]
#[contracttype]
pub enum BiodiversityMetrics {
    Absent,
    Present((i128, i128, i128)), // (habitat_area_ha, species_abundance, biodiversity_units)
}

// Distribute coupon for a given period (report referenced by on-chain report_id)
pub fn distribute_coupon(
    env: Env,
    caller: Address,
    bond_id: BondId,
    period: u32,
    holders: Vec<Address>,
    report_id: ReportId,     // must reference a Verified oracle report
    nonce: u64,
) -> CouponResult { ... }

// Admin sweeps integer-division remainder that holders could not be allocated
pub fn sweep_undistributed(env: Env, caller: Address, bond_id: BondId, nonce: u64) -> i128 { ... }

// Query accrued credits for a bondholder
pub fn accrued_credits(
    env: Env,
    bond_id: BondId,
    holder: Address,
) -> i128 { ... }

// Query accrued credits for a bondholder, split by credit type
pub fn accrued_credits_by_type(
    env: Env,
    bond_id: BondId,
    holder: Address,
    credit_type: CreditType,
) -> i128 { ... }
```

Credit allocation is **methodology-aware**: the credit type stored on the bond (`BondConfig.credit_type`, captured by `register_bond`) determines how raw report figures are converted into credits.

- `Carbon` bonds: `credits = carbon_sequestered_kg / 1_000` (1 credit per tonne).
- `Biodiversity` bonds: credits from habitat area, species abundance, and biodiversity units via per-methodology rates.
- `Basket` bonds: a combined coupon where carbon and biodiversity credits are accrued **separately per type** (queryable via `accrued_credits_by_type`) while still reported as a combined total in `CouponResult`.

---

### `OracleConsumer`

Validates and ingests signed oracle reports, anchoring real-world ecological data on-chain. Only approved oracle providers may submit reports, and each report is validated against the project's registered methodology.

```rust
// Register an approved oracle provider
pub fn register_provider(
    env: Env,
    admin: Address,
    provider: Address,
    methodology: Symbol,
) -> Result<(), OracleError> { ... }

// Commit / withdraw provider staking collateral
pub fn add_stake(env: Env, provider: Address, amount: i128, nonce: u64) -> Result<(), OracleError> { ... }
pub fn withdraw_stake(env: Env, provider: Address, amount: i128, nonce: u64) -> Result<(), OracleError> { ... }

// Submit a signed measurement report
pub fn submit_report(
    env: Env,
    provider: Address,
    project_id: BytesN<32>,
    period_start: u64,
    period_end: u64,
    carbon_sequestered: i128,
    biodiversity: BiodiversityMetrics,
    methodology: Symbol,
    ipfs_evidence_hash: BytesN<32>,
    nonce: u64,
) -> Result<ReportId, OracleError> { ... }

// Challenge a submitted report (opens 72-hour dispute window)
pub fn challenge_report(
    env: Env,
    challenger: Address,
    report_id: ReportId,
    counter_evidence_hash: BytesN<32>,
) -> Result<(), OracleError> { ... }
```

---

### `DEXRouter`

Manages bond token and coupon credit listings, order routing, and settlement on the Stellar DEX. The router abstracts Stellar's native DEX primitives and provides a unified interface for the NbS Bond marketplace.

```rust
// Escrow quote assets before trading
pub fn deposit_quote(env, caller, symbol, amount) -> Result<(), DEXError>
pub fn withdraw_quote(env, caller, symbol, amount) -> Result<(), DEXError>
pub fn get_quote_balance(env, address, symbol) -> i128

// List bond tokens for sale on Stellar DEX
pub fn list_bond_tokens(
    env: Env,
    seller: Address,
    bond_id: BondId,
    amount: i128,
    price_per_token: i128,  // In USDC stroops
    nonce: u64,
) -> Result<OrderId, DEXError> { ... }

// Execute a purchase funded from escrowed quote balance
pub fn execute_purchase(
    env: Env,
    buyer: Address,
    order_id: OrderId,
    amount: i128,
    max_price: i128,
    nonce: u64,
) -> Result<(), DEXError> { ... }
```

Purchases are funded from the buyer's escrowed quote balance (`deposit_quote`); a fill atomically transfers both bond tokens and the escrowed quote so a purchase either fully settles or fully reverts.

---

### `ProjectRegistry`

Maintains the canonical on-chain registry of all NbS projects eligible for bond backing. Projects must pass an approval process before a bond tranche may reference them.

---

### `CreditRetirement`

Handles the permanent on-chain retirement of carbon and biodiversity credits. Retired credits are burned and a retirement certificate is recorded for the retiring wallet, carrying the bond, project, oracle report and vintage year the credits originated from — usable for corporate net-zero disclosures. See [docs/retirement-certificates.md](docs/retirement-certificates.md).

---

## 🛰️ Oracle & Project Performance

The integrity of this protocol depends entirely on the quality and trustworthiness of its ecological data. NbS Bond Protocol employs a **multi-source, multi-layer oracle architecture**:

### Data Sources

| Source | Type | Frequency | Use |
|---|---|---|---|
| Accredited Auditors (Verra, Gold Standard) | Third-party verification | Annual | Baseline & periodic verification |
| Satellite Imagery (Sentinel-2, Landsat) | Remote sensing | Monthly | NDVI, biomass proxy, deforestation alerts |
| IoT Sensors | In-situ measurement | Continuous | Soil carbon, water table, microclimate |
| Blue Carbon Surveys | Plot-level measurement | Seasonal | Mangrove/seagrass/saltmarsh biomass & soil carbon |
| Community Monitors | Ground truth | Quarterly | Species surveys, canopy cover |

### Oracle Security Model

1. **Provider Whitelisting** — Only addresses registered by the protocol admin may submit reports to `OracleConsumer`
2. **Multi-signature Validation** — High-value reports (backing bonds >$1M) require 2-of-3 provider signatures
3. **Challenge Window** — Any stakeholder may challenge a submitted report within 72 hours by submitting counter-evidence (IPFS hash)
4. **Dispute Resolution** — Challenged reports are frozen pending review by the protocol's dispute committee; coupons are held in escrow during disputes
5. **Staking & Slashing** — Providers commit staked collateral via `add_stake`; a challenge resolved to `Rejected` slashes **10%** of that stake, and a provider whose stake reaches zero is deactivated and loses whitelist status. Exonerated providers (`Verified` verdict) are not penalized.

### Performance Calculation

Credit coupons are calculated as:

```
credits_per_period = (carbon_sequestered_kg / 1000) * credit_conversion_factor
bondholder_credits = credits_per_period * (bondholder_tokens / total_tokens)
```

Where `credit_conversion_factor` is set at bond issuance and reflects the methodology's conversion ratio between measured biomass growth and certified carbon credits.

---

## 🌐 Oracle Adapters

The standalone adapters in `oracle/` poll real upstream endpoints, validate every response against a documented schema, and produce IPFS-anchored measurement reports whose fields mirror the on-chain `Report` struct (`period_start`, `period_end`, `carbon_sequestered`, `methodology`, `ipfs_evidence_hash`).

### Adapters

| Adapter | File | Upstream | Methodology | Input schema (`oracle/schemas.ts`) |
|---|---|---|---|---|
| Verra registry | `oracle/verra-adapter.ts` | `VERRA_REGISTRY_URL` (Verra-compatible VCS registry) | `VERRA-VCS` | `VerraProjectSchema`, `VerraMonitoringReportSchema` |
| Satellite | `oracle/satellite-processor.ts` | `SATELLITE_API_URL` (Sentinel-2 / Landsat NDVI stats) | `REMOTE-SENSING` | `SatelliteSceneSchema`, `SatelliteProjectConfigSchema` |
| IoT | `oracle/iot-aggregator.ts` | `IOT_API_URL` (in-situ soil sensors) | `IOT-SENSORS` | `IoTSensorReadingSchema`, `IotProjectConfigSchema` |
| Blue carbon | `oracle/blue-carbon-adapter.ts` | `BLUE_CARBON_API_URL` (mangrove/seagrass/saltmarsh plot surveys) | `BLUE-CARBON` | `BlueCarbonSurveySchema`, `BlueCarbonProjectConfigSchema` |

All four validate their inputs **before** producing a report; a response that violates its schema raises a typed error (`VerraSchemaError`, `SatelliteSchemaError`, `IotSchemaError`, `BlueCarbonSchemaError`) and no report is emitted. The output of every adapter is validated against `OracleReportSchema` (see `ipfs/schemas/oracle-report.schema.json`) before it is returned.

### Report format

```json
{
  "project_id": "VCS-1234",
  "provider": "VerraRegistry",
  "methodology": "VERRA-VCS",
  "period_start": "2025-01-01",
  "period_end": "2025-03-31",
  "carbon_sequestered": 50000,
  "confidence": 0.95,
  "ipfs_evidence_hash": "QmTttqvnJq63tghnv38Uwkd7DWs9NZqfidavoZTisGKX3U",
  "evidence": { "verra_report_ids": ["MR-2024-0112"], "credits_issued": 50 }
}
```

`ipfs_evidence_hash` is a content-addressed IPFS CIDv0: the canonical (key-sorted) JSON of the report is SHA-256 hashed and base58btc-encoded by `ipfs/evidence.ts`, so the hash is deterministic, tamper-evident, and can be pinned to IPFS/Pinata via `uploadEvidence` (requires `IPFS_API_KEY`/`IPFS_SECRET_KEY`). When no pinning credentials are configured, adapters still produce the hash offline — perfect for local development and tests.

### Running each adapter against test data

No network is required. The `oracle/` package ships fixtures in `oracle/testdata/` and a file-backed `HttpClient` (`oracle/run.ts`) that serves them in place of the live endpoints:

```bash
cd oracle
npm install

npm run ingest:verra       # poll Verra registry fixture → OracleReport
npm run ingest:satellite   # ingest NDVI scenes fixture → OracleReport
npm run ingest:iot         # aggregate sensor readings fixture → OracleReport
npm run ingest:blue-carbon # aggregate blue carbon surveys fixture → OracleReport
npm run ingest             # run all four adapters
```

Unit tests mock the upstream HTTP surface (`oracle/test-helpers.ts`) and cover success and error paths (schema violations, 404/500 responses, empty periods, missing credentials):

```bash
cd oracle
npm test                   # jest
npm run typecheck          # tsc --noEmit
```

To point an adapter at a live registry instead, set the matching environment variable (`VERRA_REGISTRY_URL`, `SATELLITE_API_URL`, `IOT_API_URL`, `BLUE_CARBON_API_URL`) and call the exported ingest function, e.g. `pollVerraProject('VCS-1234', { periodStart: '2025-01-01', periodEnd: '2025-03-31' })`.

### Measurement models

- **Verra** — sums `carbon_sequestered_kg` across reports whose `verification_status === 'VERIFIED'` and whose reporting period falls inside the requested window.
- **Satellite** — averages NDVI over scenes with cloud cover ≤ 20%, converts the change from `baseline_ndvi` into kg CO2e using a simplified IPCC Tier 1 factor (`area_ha × ndvi_change × 3.67 tC/ha × 44/12`). The factor is a methodology placeholder and must be tuned per project.
- **IoT** — validates each reading, aggregates soil moisture/temperature/humidity/water table, and estimates sequestration from the per-device mean change in soil organic carbon (ppm) over the period: `Δppm × area_ha × 15.4 kg CO2e·ha⁻¹·ppm⁻¹` (assumes 1.4 t/m³ bulk density, 0.3 m sampling depth). Devices without a start/end reading contribute no delta.
- **Blue carbon** — aggregates seasonal plot surveys and estimates net sequestration from the change in mean carbon stock (aboveground biomass + belowground biomass via the project's root-to-shoot ratio + soil organic carbon) against the project baseline: `Δstock_t·ha⁻¹ × area_ha × 44/12 × 1000 kg CO2e`. Periods where the stock falls below baseline contribute zero credits.

---

## 🌱 Credit Types Supported

### Carbon Credits (tCO₂e)

Standard carbon credits representing verified carbon sequestration or avoidance. Measured in metric tonnes of CO₂ equivalent. Compatible with:
- Verra VCS (Verified Carbon Standard)
- Gold Standard
- American Carbon Registry (ACR)
- Climate Action Reserve (CAR)

### Biodiversity Credits

Emerging credit type representing measurable biodiversity outcomes. Units vary by methodology:
- Habitat hectares restored
- Species Abundance Index (SAI) improvement
- Biodiversity Unit (UK BNG methodology)

### Blue Carbon Credits

Credits from coastal and marine ecosystems — mangroves, seagrass beds and saltmarshes — that sequester carbon at 3–5x the rate of terrestrial forests. Units are tCO₂e measured against a project baseline carbon stock via plot-level biomass and soil carbon surveys (see [Credit Methodology](./docs/credit-methodology.md)). Compatible with:
- Verra VM0033 (Tidal Wetland and Seagrass Restoration)
- Blue Carbon Initiative methodologies

### Basket Credits

A composite coupon containing a defined ratio of carbon and biodiversity credits. Allows issuers to design instruments aligned with dual-objective projects (e.g., a mangrove restoration that generates both carbon and biodiversity outcomes).

---

## 🔄 Secondary Market

Bond tokens and credit coupon tokens are standard **Stellar Assets**, making them natively compatible with the Stellar DEX. The secondary market is fully permissionless — no protocol approval is needed to list or trade.

### Trading Pairs

| Pair | Description |
|---|---|
| `BOND-XLM` | Bond tokens priced in XLM |
| `BOND-USDC` | Bond tokens priced in USDC |
| `CARBON-USDC` | Carbon credit coupons priced in USDC |
| `BIO-USDC` | Biodiversity credit coupons priced in USDC |
| `CARBON-BOND` | Credits swapped directly for bond tokens |

### Stellar DEX Features Used

- **Order Book** — Limit and market orders for bond tokens and credit coupons
- **Path Payments** — Investors can purchase bond tokens using any Stellar asset (XLM, USDC, etc.) via Stellar's built-in path-finding
- **CLMM Pools** — Concentrated liquidity pools for deep liquidity on high-volume credit pairs
- **Offers API** — The `DEXRouter` contract creates and manages passive offers for automated credit distribution

---

## 🔐 Security Model

### Smart Contract Security

| Mechanism | Description |
|---|---|
| Nonce-based replay protection | Every state-changing call consumes a unique nonce per address |
| Access control | Admin-only functions guarded by `require_auth()` |
| Re-entrancy guards | State updates before external calls throughout |
| Integer overflow protection | Rust's native overflow checking in all arithmetic |
| Upgrade pattern | Contracts upgradeable via timelock (48hr delay) |

### Operational Security

- All admin keys are held in hardware security modules (HSMs)
- Multi-sig (3-of-5) required for protocol parameter changes
- 48-hour timelock on all contract upgrades
- Public bug bounty program (see [Security Disclosure](#-security-disclosure))
- Quarterly third-party smart contract audits

### Oracle Security

- Provider whitelist with staked collateral (`add_stake` / `withdraw_stake`, 10% slash on rejected challenges)
- 72-hour challenge window on all submitted reports
- Multi-sig required for high-value bond reports
- Dispute resolution committee with on-chain escalation path

---

## 🚀 Getting Started

### Prerequisites

Ensure the following are installed on your development machine:

- **Node.js** `v18+` and **npm** `v9+`
- **Rust** (stable toolchain) and **Cargo**
- **Soroban CLI** — `cargo install --locked soroban-cli`
- **Stellar CLI** — see [Stellar docs](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli)
- **IPFS CLI** or a [Pinata](https://pinata.cloud) account for IPFS pinning
- A funded **Stellar testnet account** (use [Friendbot](https://friendbot.stellar.org))

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/nbs-bond-protocol.git
cd nbs-bond-protocol

# Install API dependencies
cd api && npm install && cd ..

# Install frontend dependencies
cd frontend && npm install && cd ..

# Build all Soroban contracts
cd contracts && cargo build --release && cd ..
```

### Quick Start (Testnet)

```bash
# 1. Configure environment
cp .env.example .env
# Edit .env with your Stellar keys and API credentials

# 2. Deploy contracts to testnet
./scripts/deploy-testnet.sh

# 3. Seed one bond, two oracle providers, and a verified report
set -a && source .env && set +a
NODE_PATH=api/node_modules api/node_modules/.bin/ts-node --transpile-only scripts/seed-testnet.ts

# 4. Start the API server
cd api && npm run start:dev

# 5. Start the Angular frontend
cd frontend && ng serve

# 6. Open the app
open http://localhost:4200
```

### Wallet Requirement (Freighter)

Signing in requires the [Freighter](https://www.freighter.app/) browser extension. If it is
not installed, the app shows an install prompt linking to the listing for your browser
(Chrome Web Store for Chrome, Brave and Edge; Firefox Add-ons for Firefox) rather than
failing silently. Install the extension and use **I have installed it — retry** — no page
reload needed, since Freighter injects itself as soon as its content script runs.

Prompts you dismiss inside Freighter (connection or signature requests) are reported as
declined, distinct from the extension being absent.

---

## 🔧 Environment Variables

Create `.env` from the provided template:

```env
# ── Stellar Network ──────────────────────────────────────────────
STELLAR_NETWORK=testnet                        # testnet | mainnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_PUBLIC_KEY=G...                        # Admin public key (used by deploy scripts)

# ── Signer Keys (used by the API to build transactions) ──────────
ADMIN_SECRET_KEY=S...                          # Issuer/admin secret key
USER_SECRET_KEY=S...                           # Regular user (developer) secret key
INVESTOR_SECRET_KEY=S...                       # Investor secret key

# ── Contract Addresses (populated after deployment) ──────────────
BOND_ISSUER_ADDRESS=C...
COUPON_ENGINE_ADDRESS=C...
ORACLE_CONSUMER_ADDRESS=C...
DEX_ROUTER_ADDRESS=C...
PROJECT_REGISTRY_ADDRESS=C...
CREDIT_RETIREMENT_ADDRESS=C...

# ── IPFS / Pinata ────────────────────────────────────────────────
IPFS_API_URL=https://api.pinata.cloud
IPFS_API_KEY=your_pinata_api_key
IPFS_SECRET_KEY=your_pinata_secret_key
IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs/

# ── Oracle ───────────────────────────────────────────────────────
# Whitelisted provider addresses allowed to submit reports
ORACLE_PROVIDER_WHITELIST=G...                 # Comma-separated list of provider addresses
DEFAULT_PROVIDER_ADDRESS=G...                  # Default provider used by the scheduler

# ── Authentication ───────────────────────────────────────────────
JWT_SECRET=your_very_long_jwt_secret_here
JWT_EXPIRY=7d
KYC_PROVIDER_URL=https://kyc.your-provider.com
KYC_API_KEY=your_kyc_api_key

# ── Database ─────────────────────────────────────────────────────
DATABASE_URL=postgresql://user:password@localhost:5432/nbs_bond
REDIS_URL=redis://localhost:6379

# ── App ──────────────────────────────────────────────────────────
PORT=3000
NODE_ENV=development
LOG_LEVEL=debug
```

---

## 📁 Project Structure

```
nbs-bond-protocol/
│
├── contracts/                          # Soroban smart contracts (Rust)
│   ├── bond-issuer/
│   │   ├── src/lib.rs
│   │   └── Cargo.toml
│   ├── coupon-engine/
│   │   ├── src/lib.rs
│   │   └── Cargo.toml
│   ├── oracle-consumer/
│   │   ├── src/lib.rs
│   │   └── Cargo.toml
│   ├── dex-router/
│   │   ├── src/lib.rs
│   │   └── Cargo.toml
│   ├── project-registry/
│   │   ├── src/lib.rs
│   │   └── Cargo.toml
│   ├── credit-retirement/
│   │   ├── src/lib.rs
│   │   └── Cargo.toml
│   └── shared/                         # Shared types and utilities
│       ├── src/types.rs
│       └── src/errors.rs
│
├── api/                                # NestJS backend
│   ├── src/
│   │   ├── bonds/
│   │   │   ├── bonds.controller.ts
│   │   │   ├── bonds.service.ts
│   │   │   ├── bonds.module.ts
│   │   │   └── dto/
│   │   ├── oracle/
│   │   │   ├── oracle.service.ts
│   │   │   ├── oracle.scheduler.ts
│   │   │   └── providers/
│   │   │       ├── verra.provider.ts
│   │   │       └── satellite.provider.ts
│   │   ├── projects/
│   │   │   ├── projects.controller.ts
│   │   │   ├── projects.service.ts
│   │   │   └── ipfs.service.ts
│   │   ├── marketplace/
│   │   │   ├── marketplace.controller.ts
│   │   │   ├── dex.service.ts
│   │   │   └── liquidity.service.ts
│   │   ├── auth/
│   │   │   ├── auth.controller.ts
│   │   │   ├── auth.service.ts
│   │   │   ├── jwt.strategy.ts
│   │   │   └── kyc.service.ts
│   │   ├── stellar/
│   │   │   ├── stellar.service.ts
│   │   │   └── contract.service.ts
│   │   └── app.module.ts
│   ├── test/
│   └── package.json
│
├── frontend/                           # Angular application
│   ├── src/
│   │   ├── app/
│   │   │   ├── dashboard/             # Investor portfolio view
│   │   │   ├── projects/              # Project registry & detail pages
│   │   │   ├── marketplace/           # DEX trading interface
│   │   │   ├── bonds/                 # Bond issuance (issuer role)
│   │   │   ├── auth/                  # Login, KYC flow
│   │   │   └── shared/                # Shared components & services
│   │   ├── assets/
│   │   └── environments/
│   └── package.json
│
├── oracle/                             # Oracle adapter scripts
│   ├── verra-adapter.ts                #   Verra-compatible registry poller
│   ├── satellite-processor.ts          #   Sentinel-2/Landsat NDVI ingestion
│   ├── iot-aggregator.ts               #   In-situ soil sensor aggregation
│   ├── schemas.ts                      #   Zod input/output schemas
│   ├── report.ts                       #   Report builder + evidence hashing
│   ├── run.ts                          #   Run adapters against testdata fixtures
│   ├── http.ts                         #   Swappable HTTP surface for adapters
│   └── testdata/                       #   Mock upstream fixtures + specs
│
├── ipfs/                               # IPFS upload utilities & schemas
│   ├── evidence.ts                     #   CIDv0 evidence hashing + pinning
│   ├── schemas/
│   │   ├── project-prospectus.schema.json
│   │   └── oracle-report.schema.json
│   └── upload.ts
│
├── scripts/                            # Deployment & migration scripts
│   ├── deploy-testnet.sh
│   ├── deploy-mainnet.sh
│   ├── migrate.ts
│   └── seed-testnet.ts
│
├── docs/                               # Extended documentation
│   ├── architecture.md
│   ├── oracle-design.md
│   ├── credit-methodology.md
│   └── governance.md
│
├── .github/
│   ├── workflows/
│   │   ├── ci.yml
│   │   └── deploy.yml
│   └── ISSUE_TEMPLATE/
│
├── .env.example
├── docker-compose.yml
├── CONTRIBUTING.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
└── LICENSE
```

---

## 🌐 API Reference

### Bonds

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/bonds` | Issue a new bond tranche |
| `GET` | `/bonds` | List all active bond tranches |
| `GET` | `/bonds/:id` | Get bond tranche details |
| `POST` | `/bonds/:id/subscribe` | Subscribe to a bond tranche |
| `GET` | `/bonds/:id/holders` | List all token holders |
| `POST` | `/bonds/:id/coupon` | Trigger coupon distribution (admin) |

### Projects

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/projects` | Register a new NbS project |
| `GET` | `/projects` | List all registered projects |
| `GET` | `/projects/:id` | Get project details and oracle history |
| `POST` | `/projects/:id/documents` | Upload project documentation to IPFS |

### Marketplace

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/marketplace/orders` | List open DEX orders |
| `POST` | `/marketplace/list` | List bond tokens for sale |
| `POST` | `/marketplace/buy` | Purchase bond tokens |
| `GET` | `/marketplace/prices` | Current DEX prices for all pairs |

### Oracle

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/oracle/reports` | Submit a measurement report (providers only) |
| `GET` | `/oracle/reports/:projectId` | Get oracle history for a project |
| `POST` | `/oracle/challenge/:reportId` | Challenge a submitted report |
| `GET` | `/oracle/providers` | List registered oracle providers with stake and health |
| `POST` | `/oracle/providers` | Register a new oracle provider (admin only) |

---

## 🧪 Testing

### Smart Contracts

```bash
cd contracts

# Run all contract tests
cargo test

# Run tests for a specific contract
cargo test -p bond-issuer

# Run with output
cargo test -- --nocapture
```

### API

```bash
cd api

# Unit tests
npm run test

# Integration tests (requires testnet connection)
npm run test:e2e

# Coverage report
npm run test:cov
```

### Frontend

```bash
cd frontend

# Unit tests
ng test

# E2E tests
ng e2e
```

---

## 🚢 Deployment

### Testnet Deployment

```bash
# Deploy all contracts to Stellar testnet
./scripts/deploy-testnet.sh

# The script writes contract addresses into .env automatically
# BOND_ISSUER_ADDRESS=C...
# COUPON_ENGINE_ADDRESS=C...
# etc.
```

### Mainnet Deployment

```bash
# Requires STELLAR_PUBLIC_KEY in environment with sufficient XLM
# Always run a full audit before mainnet deployment

./scripts/deploy-mainnet.sh
```

### Docker

```bash
# Start all services (API + PostgreSQL + Redis)
docker-compose up -d

# View logs
docker-compose logs -f api
```

---

## 🏛️ Governance

NbS Bond Protocol is governed by a multi-stakeholder committee comprising:

- **Project Developers** — Register and manage NbS projects
- **Bond Issuers** — Structure and issue bond tranches
- **Oracle Providers** — Submit ecological measurement data
- **Protocol Maintainers** — Core development team
- **Token Holders** — Investors holding active bond tokens

### Governance Actions

The following protocol parameters require multi-sig governance approval:

- Adding or removing oracle providers
- Updating credit conversion factors
- Deploying contract upgrades (subject to 48-hour timelock)
- Modifying KYC requirements
- Adjusting dispute resolution parameters

Governance proposals are submitted via on-chain transactions and ratified by a 3-of-5 multi-sig held across geographically distributed keyholders.

---

## ✅ Compliance & KYC

NbS Bond Protocol takes a pragmatic approach to compliance:

- **KYC/AML** is handled off-chain via an integrated third-party provider before any investor may subscribe to a bond tranche
- **Accredited investor checks** are configurable per tranche by the bond issuer
- **Jurisdiction restrictions** can be encoded at the tranche level
- **On-chain identity** is abstracted — the smart contracts enforce KYC status via an allow-list maintained by the NestJS API, without storing personal data on-chain
- **Credit retirement certificates** are ICAO-compatible for corporate net-zero reporting

---

## 🗺️ Roadmap

| Phase | Milestone | Status |
|---|---|---|
| **Phase 1** | Core smart contracts (BondIssuer, CouponEngine, ProjectRegistry, CreditRetirement) | ✅ Delivered |
| **Phase 2** | Oracle integration & testnet deployment | 🟡 In Progress — oracle adapters (Verra, satellite, IoT) and `OracleConsumer` with staking/slashing are live in code; testnet deployment scripts ready, not yet verified on a live network |
| **Phase 3** | Angular frontend MVP | ✅ Delivered |
| **Phase 4** | Stellar DEX secondary market integration (escrowed settlement via `DEXRouter`) | ✅ Delivered |
| **Phase 5** | Third-party smart contract audit | 📋 Not started |
| **Phase 6** | Mainnet launch with pilot reforestation bond | 📋 Not started — `deploy-mainnet.sh` scaffolded |
| **Phase 7** | Blue carbon bond support | ✅ Delivered — `CreditType::BlueCarbon`, `BLUE-CARBON` oracle adapter, methodology docs |
| **Phase 8** | Biodiversity credit coupon support | 🔭 Future (partial — `CreditType::Biodiversity` supported) |
| **Phase 9** | Governance token & DAO transition | 🔭 Future (governance documented, multi-sig not on-chain) |
| **Phase 10** | Multi-chain bridge for credit portability | 🔭 Future |

---

## 🤝 Contributing

We welcome contributions from smart contract engineers, climate scientists, financial modelers, oracle architects, and frontend developers.

### How to Contribute

1. **Fork** the repository
2. **Create** a feature branch: `git checkout -b feature/oracle-verra-adapter`
3. **Commit** using conventional commits:
   - `feat(oracle): add Verra feed adapter`
   - `fix(coupon): correct pro-rata calculation`
   - `docs(readme): expand oracle security section`
4. **Push** and open a **Pull Request** against `main`

### Contribution Areas

- 🦀 **Soroban Contracts** — Rust engineers who know Stellar's VM
- 🌐 **Oracle Adapters** — Integrations with new ecological data providers
- 🌱 **Credit Methodologies** — Climate scientists who can model new project types
- 🎨 **Frontend** — Angular engineers and UX designers
- 🔒 **Security** — Auditors and security researchers
- 📄 **Documentation** — Technical writers and protocol explainers

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) before submitting.

---

## 🔒 Security Disclosure

We take security extremely seriously. If you discover a vulnerability, **please do not open a public GitHub issue.**

Instead, email **security@nbs-bond-protocol.org** with:
- A description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- (Optional) Suggested fix

We operate a **bug bounty program** with rewards up to **$50,000 USDC** for critical smart contract vulnerabilities. Response time SLA: 48 hours for acknowledgement, 7 days for triage.

See [SECURITY.md](./SECURITY.md) for the full disclosure policy and bounty tiers.

---

## 📄 License

This project is licensed under the **MIT License** — see [LICENSE](./LICENSE) for details.

---

## 🙏 Acknowledgements

- [Stellar Development Foundation](https://stellar.org) — for Soroban and the Stellar network
- [Verra](https://verra.org) — VCS methodology and carbon credit standards
- [Gold Standard](https://goldstandard.org) — for co-benefit certification frameworks
- [CarbonChain](https://carbonchain.com) — for credit infrastructure and oracle foundations
- The global community of reforestation and blue carbon scientists whose fieldwork makes this possible

---

<div align="center">

**Built for the planet. Powered by Stellar.**

*NbS Bond Protocol — where financial returns and ecological restoration are the same thing.*

⭐ Star this repo if you believe DeFi can help heal the planet ⭐

</div>
