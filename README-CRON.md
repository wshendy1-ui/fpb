# FPB national ratings cron (v1)

Daily precompute: Open-Meteo forecast (single model, batched multi-point) ×
your climo-fetcher normals → per-zone 7-day composite tiers, written as static
JSON for the map's choropleth + time scrubber.

## Repo layout this package assumes

```
repo/
  engine/                      <- from fpb-engine_v1.zip (core.js, sources.js)
  cron/rate_national.js        <- this package
  data/zones_points.csv        <- climo-fetcher out/zones_points.csv (poi-v1)
  climo/*.json                 <- climo-fetcher out/climo/
  ratings/                     <- output (latest.json + dated files), committed daily
  .github/workflows/fpb-daily.yml
```

## Setup

1. Copy your fetcher outputs into `data/` and `climo/` as above.
2. Repo Settings → Secrets and variables → Actions → **New repository secret**:
   `OM_API_KEY` = your Open-Meteo key. The key never appears in code or logs.
3. Actions tab → *FPB daily national ratings* → **Run workflow** (first manual run).
4. Confirm `ratings/latest.json` appears; schedule then runs daily at 12:40 UTC.

## Local runs

```
node cron/rate_national.js --zones data/zones_points.csv --climo climo --out ratings --limit 5    # probe
node cron/rate_national.js --zones data/zones_points.csv --climo climo --out ratings --states OR,WA
node cron/rate_national.js --zones data/zones_points.csv --climo climo --out ratings              # full
```

`OM_BASE` env overrides the endpoint (used by the offline test's mock server).
`.env` with `OM_API_KEY=...` in the working directory also works locally.

## Units and pacing

The script prints its API call count (batch of 40 zones = 1 call, ~24 calls for
your 940). Open-Meteo may meter per *location* rather than per call, so budget
~1,000–1,500 units/day for 940 zones until the first live run confirms actual
spend on your dashboard — roughly 20–30k for the rest of this month, well inside
your reserved headroom. 429s retry the same batch after a 60s backoff (max 4); **sustained rate
limiting aborts the run without writing output**, so the map keeps serving
yesterday's `latest.json` rather than a half-painted country. Batch failures
log their reason and fall back to per-zone singles.

## v1.2 changes

- **Fixed the CAZ271 / IDZ421 / NVZ438 failures**: zone names containing
  commas (quoted in the CSV) shifted columns under the old naive split, so
  latitude received a longitude. Parsing is now quote-aware, and any row
  with out-of-range coordinates is skipped *before* spending API calls
  (reported in `bad_coords`). Expect **940 rated · 0 failed · 24 calls**.
- **Schema `fpb-national-2`**: per-zone `wx` arrays (tmax, RHmin, RHrec,
  wind, gust, PoP, CAPE, precip — rounded) and per-row severity arrays
  (`rows`), plus doc-level `weights` and a `ladder` tag. Powers the map's
  day-weather panel, top-2 drivers, T0/T1 inhibitor — and the ladder
  calibration analysis.
- Parse failures now log a 200-char response snippet for self-diagnosis.
- Workflow gains a 13:40 UTC safety-net schedule with an idempotence guard
  (scheduled runs exit early if today's dated file exists; manual runs
  always execute).

## Output schema (`fpb-national-2`)

```json
{
  "schema": "fpb-national-1",
  "generated": "2026-07-15T12:41:03Z",
  "pointset_version": "poi-v1",
  "model": "gfs_seamless",
  "days": ["2026-07-15", "..."],
  "ladder": "v83-normalT2",
  "weights": { "tmax":0.8, "rhmin":1.3, "...":0 },
  "zones": {
    "ORZ693": { "t": [4,...], "s": [3.1,...], "dl": [4,...], "drv": ["rhmin",...],
                "rows": { "tmax":[3,...], "rhmin":[4,...], "rhrec":[...], "wind":[...], "gust":[...], "pop":[...] },
                "wx":   { "tmax":[95,...], "rhmin":[11,...], "rhrec":[...], "wind":[...], "gust":[...], "pop":[...], "cape":[...], "precip":[...] } }
  },
  "failed": [], "no_climo": 0, "bad_coords": [], "dropped_vars": []
}
```

`t` tier 0–4 per day (paints the choropleth) · `s` composite score ·
`dl` dry-lightning severity (lightning overlay) · `drv` top driver id (tooltip).
`latest.json` is what the map loads; dated files accumulate for verification.

## National v1 vs local refined — read this once

The national composite deliberately scores a **subset** of the v83 row set:
tmax / RHmin / RH-recovery (sigma vs zone normals), wind / gust / PoP
(absolute ladders), and dry lightning via the **CAPE path** (no NWS PoT at
national scale — CAPE ≥400 on a dry day flags MED, ≥1000 HIGH, exactly v83's
fallback). HDW, Haines, FFWI/VPD, LAL, RFW alerts, and all FEMS fuels rows are
**deep-dive only** — this is why a selected zone's refined rating can differ
from the national paint, and why the UI shows a REFINED badge.

Day-0 RH-recovery uses only the current morning's hours (no prior evening in a
forecast that starts today) — same behavior as v83.

## Failure semantics

A zone with no climo file is skipped and counted (`no_climo`), not failed.
A failed batch falls back to per-zone singles so one bad point can't take down
its batch-mates; unrecoverable zones land in `failed[]`. Variables rejected by
the API are shed by the engine's self-heal and reported in `dropped_vars`.
