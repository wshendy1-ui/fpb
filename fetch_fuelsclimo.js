#!/usr/bin/env node
"use strict";
/* =========================================================================
   FPB — fetch_fuelsclimo.js  (v1)

   Pulls NFDRS percentile breakpoints straight from the FEMS climatology
   GraphQL endpoint — the same call the public seasonal-trend charts make —
   and writes out/fuels-climo/{zone}.json.

   Why this exists: ERC/BI/IC and the dead fuel moistures score on national
   absolute ladders unless a user hand-calibrates a zone on their own device.
   Roberts Butte's real ERC p90 is 52.19; the app's default is 65. An ERC of
   55 is a top-decile day there and was scoring a 1. Publishing per-zone
   breakpoints puts every device and both products on the same yardstick with
   nobody calibrating anything — the same move climo/{zone}.json made for wx.

   No history download and no percentile math: FEMS computes and returns the
   breakpoints. One request per station.

   Usage:
     node fetch_fuelsclimo.js --probe                 one station, print raw
     node fetch_fuelsclimo.js                         all zones in ZONES below
     node fetch_fuelsclimo.js --zone ORZ693
     node fetch_fuelsclimo.js --season annual         default is mayoct
     node fetch_fuelsclimo.js --years 2005-2024
   ========================================================================= */
const fs = require("fs");
const path = require("path");

/* ---------------------------------------------------------------------------
   CANONICAL ROSTERS — the zone's fuels stations, the fuels analogue of the
   zone POI. Same rule as autoPickInZone: in-zone, live, permanent RAWS.
   Fill these in; everything downstream is derived.
   --------------------------------------------------------------------------- */
const ZONES = {
  /* Wallowa Fire Zone = ORZ693 + ORZ695. */
  ORZ693: { name: "Canyon Grassland of Wallowa County",
            stations: ["351520"] },                       /* Roberts Butte — the only in-zone RAWS */
  ORZ695: { name: "Eagle Cap Wilderness",
            stations: ["352418", "351502", "351419"] },   /* Sparta Butte, Harl Butte, Point Prom II */
};
const STN_NAMES = { "351520": "Roberts Butte", "352418": "Sparta Butte",
                    "351502": "Harl Butte",   "351419": "Point Prom II" };

const API   = "https://fems.fs2c.usda.gov/api/climatology/graphql/";
const PCTS  = "3,10,20,50,80,90,97";  /* 80 for ERC/BI; 20+50 so the inverted moisture
                                         rows get a four-step ladder instead of two */
const MODELS = ["Y", "V", "W", "X"];
const SEASONS = { mayoct: ["05-01", "10-31"], annual: ["01-01", "12-31"] };

/* ---------------------------------------------------------------------------
   REGION PROFILES — which indices a region actually keys on.
   Not a user toggle: a toggle would let two people rate the same zone
   differently, which is the thing the canonical zone point exists to prevent.
   The profile belongs to the zone, so crossing into R8 changes the emphasis
   automatically and identically for everyone.
   KBDI is the case in point: drought context in R6, a decision driver in R8
   (Keetch & Byram built it for southeastern organic soils).
   THESE WEIGHTS ARE AN APPROXIMATION OF REGIONAL PRACTICE, not doctrine —
   replace them with the numbers from the area's Fire Danger Operating Plan.
   --------------------------------------------------------------------------- */
const PROFILES = {
  R6: { erc:2.0, fm1000:1.5, bi:1.2, fm100:1.2, ic:0.8, kbdi:0.3, sc:0.4, lfm:0.6, lfw:0.6 },
  R8: { erc:1.6, kbdi:1.6, fm1000:1.4, bi:1.2, fm100:1.0, ic:0.8, sc:0.4, lfm:0.6, lfw:0.6 },
  DEFAULT: { erc:2.0, fm1000:1.5, bi:1.2, fm100:1.2, ic:0.8, kbdi:1.0, sc:0.4, lfm:0.6, lfw:0.6 },
};
const STATE_REGION = {
  OR:"R6", WA:"R6", CA:"R5", MT:"R1", ND:"R1", CO:"R2", NM:"R3", AZ:"R3",
  UT:"R4", NV:"R4", MN:"R9",
  AL:"R8", AR:"R8", FL:"R8", GA:"R8", KY:"R8", LA:"R8", MS:"R8",
  NC:"R8", SC:"R8", TN:"R8", VA:"R8",
  /* ID, WY, TX, OK straddle regions — state alone cannot decide, so they fall
     through to ZONE_REGION or DEFAULT rather than being guessed. */
};
const ZONE_REGION = {};   /* per-zone overrides for the split states, e.g. TXZ123:"R8" */

/* Coherence: the largest p90 spread across a zone's stations that still lets a
   BLENDED percentile ladder describe the zone. Beyond it the mean describes
   nowhere, so the row keeps its weight but scores on absolute thresholds.
   Separate question from relevance above — a row can matter and still be
   unusable as a zone-level ladder. Eagle Cap: ERC +/-4 (fine), KBDI +/-388. */
const MAX_SPREAD = { erc:8, bi:15, ic:25, sc:10, fm100:8, fm1000:8, fm10:12, fm1:25,
                     kbdi:120, lfm:40, lfw:40 };

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt  = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const SEASON = opt("--season", "mayoct");
const [Y0, Y1] = opt("--years", "2005-2024").split("-");
const [MD0, MD1] = SEASONS[SEASON] || SEASONS.mayoct;
const OUT = path.join(__dirname, "out", "fuels-climo");

const QUERY = `query GetPercentileLevels($stationId: String!, $fuelModel: FuelModelTypes!,
  $startYear: ClimatologyYear, $endYear: ClimatologyYear,
  $startMonthDay: ClimatologyMonthDay, $endMonthDay: ClimatologyMonthDay,
  $startHour: TimeHour, $endHour: TimeHour, $percentileLevels: String,
  $dateTimeFormat: DateTimeFormat, $visibilitySettings: TriState) {
  percentileLevels(stationIds: $stationId, fuelModel: $fuelModel,
    visibilitySettings: $visibilitySettings,
    climatology: { startYear: $startYear, endYear: $endYear,
      startMonthDay: $startMonthDay, endMonthDay: $endMonthDay,
      startHour: $startHour, endHour: $endHour, dateTimeFormat: $dateTimeFormat },
    percentileLevels: $percentileLevels, page: 0, per_page: 300000) {
    _metadata { total_count }
    data {
      station_id kbdi_max
      one_hr_tl_fuel_moisture_min ten_hr_tl_fuel_moisture_min
      hun_hr_tl_fuel_moisture_min thou_hr_tl_fuel_moisture_min
      ignition_component_max spread_component_max energy_release_component_max
      woody_lfi_fuel_moisture_max herbaceous_lfi_fuel_moisture_max burning_index_max
    }
  }
}`;

/* FEMS field -> our row id. The _min moisture fields are inverted-sense: their
   DANGER end is the low tail (3rd/10th), not the 90th/97th, and several
   saturate at the wet end (100-hr reads 23.25 at both p90 and p97). */
const MAP = {
  energy_release_component_max: { id: "erc",    dir: "high" },
  burning_index_max:            { id: "bi",     dir: "high" },
  ignition_component_max:       { id: "ic",     dir: "high" },
  spread_component_max:         { id: "sc",     dir: "high" },
  kbdi_max:                     { id: "kbdi",   dir: "high" },
  hun_hr_tl_fuel_moisture_min:  { id: "fm100",  dir: "low"  },
  thou_hr_tl_fuel_moisture_min: { id: "fm1000", dir: "low"  },
  ten_hr_tl_fuel_moisture_min:  { id: "fm10",   dir: "low"  },
  one_hr_tl_fuel_moisture_min:  { id: "fm1",    dir: "low"  },
  herbaceous_lfi_fuel_moisture_max: { id: "lfm", dir: "low" },
  woody_lfi_fuel_moisture_max:      { id: "lfw", dir: "low" },
};
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

async function ask(stationId, fuelModel) {
  const body = JSON.stringify({ query: QUERY, variables: {
    stationId: String(stationId), fuelModel,
    startYear: String(Y0), endYear: String(Y1),
    startMonthDay: MD0, endMonthDay: MD1,
    startHour: "0", endHour: "24",
    dateTimeFormat: "LocalStationTime", visibilitySettings: "ALL",
    percentileLevels: PCTS } });
  const r = await fetch(API, { method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json, text/plain, */*" },
    body });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + r.statusText);
  const j = await r.json();
  if (j.errors) throw new Error("graphql: " + JSON.stringify(j.errors).slice(0, 200));
  const rows = j.data && j.data.percentileLevels && j.data.percentileLevels.data;
  if (!rows || !rows.length) throw new Error("no rows for station " + stationId + " model " + fuelModel);
  return rows[0];
}

function shape(row) {
  const out = {};
  for (const k in MAP) {
    const src = row[k]; if (!src) continue;
    const { id, dir } = MAP[k];
    const p = {};
    for (const lvl of ["3th", "10th", "20th", "50th", "80th", "90th", "97th"]) {
      const v = num(src[lvl]);
      if (v != null) p["p" + parseInt(lvl, 10)] = v;
    }
    if (Object.keys(p).length) {
      out[id] = { dir, ...p };
      /* live herb/woody bottom out at their cured floors (30 / 60), so p3 and p10 are
         identical and cannot rank anything at the dry end. Flag it rather than ship a
         degenerate ladder — these rows stay on absolute thresholds. */
      if (dir === "low" && p.p3 != null && p.p10 != null && p.p3 === p.p10)
        out[id].degenerate = "p3 == p10 (cured floor) — no percentile ladder at the danger end";
    }
  }
  return out;
}

/* Average breakpoints across the zone's stations. NOTE: this averages each
   station's percentiles, whereas the in-app Calibrate averages the daily
   series across stations and THEN takes percentiles. Those are not identical
   — for a single-station zone they are, and for similar nearby stations they
   are close, but it is an approximation and is recorded as such below. */
function spread(perStation, row, lvl) {
  const vs = Object.keys(perStation)
    .map(s => perStation[s][row] && perStation[s][row][lvl])
    .filter(v => v != null);
  if (vs.length < 2) return null;
  return Math.round((Math.max(...vs) - Math.min(...vs)) * 100) / 100;
}
function blend(perStation) {
  const ids = Object.keys(perStation);
  if (!ids.length) return null;
  const out = {};
  for (const sid of ids) for (const row in perStation[sid]) {
    const src = perStation[sid][row];
    const dst = out[row] = out[row] || { dir: src.dir, _n: 0 };
    for (const k in src) { if (k === "dir" || k === "degenerate") continue;
      dst[k] = (dst[k] || 0) + src[k]; }
    dst._n++;
  }
  for (const row in out) { const o = out[row], n = o._n; delete o._n;
    for (const k in o) if (k !== "dir" && k !== "degenerate")
      o[k] = Math.round((o[k] / n) * 100) / 100;
    /* averaging stations lifts p3 off the cured floor, so a blended row looked usable
       while every station under it was pinned. Inherit the flag rather than hide it. */
    const anyDeg = ids.map(x => perStation[x][row]).filter(Boolean).find(r => r.degenerate);
    if (anyDeg) o.degenerate = anyDeg.degenerate;
  }
  return out;
}

const STATES = (() => {
  const f = path.join(__dirname, "data", "zones_points.csv");
  const out = {};
  try {
    const L = fs.readFileSync(f, "utf8").split(/\r?\n/);
    const h = L[0].split(","), iId = h.indexOf("id"), iSt = h.indexOf("state");
    for (let i = 1; i < L.length; i++) { const c = L[i].split(","); if (c.length > iSt) out[c[iId]] = c[iSt]; }
  } catch (e) { console.log("  (data/zones_points.csv not readable — region falls back to DEFAULT)"); }
  return out;
})();
async function main() {
  if (typeof fetch !== "function") { console.error("needs Node 18+ (global fetch)"); process.exit(1); }
  if (flag("--probe")) {
    const sid = opt("--station", "351520");
    console.log("probe:", sid, "model Y ·", Y0 + "-" + Y1, "·", MD0, "to", MD1, "· levels", PCTS);
    const row = await ask(sid, "Y");
    console.log(JSON.stringify(row, null, 1));
    console.log("\nshaped:\n" + JSON.stringify(shape(row), null, 1));
    console.log("\np80 present:", shape(row).erc && shape(row).erc.p80 != null ? "YES" : "NO — schema ignored the 80 level");
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const only = opt("--zone", null);
  for (const zid in ZONES) {
    if (only && zid !== only) continue;
    const Z = ZONES[zid];
    if (!Z.stations.length) { console.log(zid, "— no canonical stations listed, skipping"); continue; }
    const byModel = {}, errs = [];
    for (const fm of MODELS) {
      const per = {};
      for (const sid of Z.stations) {
        try { per[sid] = shape(await ask(sid, fm)); }
        catch (e) { errs.push(fm + "/" + sid + ": " + e.message); }
      }
      const b = blend(per);
      if (b) {
        /* v1.1: keep every station's own breakpoints. The blend is a mean of
           percentiles, which is only honest if the stations actually agree —
           and that is exactly what the mean hides. p90Spread is the max-minus-min
           across stations, so a zone that is not coherent says so in its own file. */
        const sp = {};
        for (const row in b) { const d = spread(per, row, "p90"); if (d != null) sp[row] = d; }
        byModel[fm] = { stations: Object.keys(per), rows: b, perStation: per, p90Spread: sp };
      }
    }
    if (!Object.keys(byModel).length) { console.log(zid, "FAILED:", errs.join(" · ")); continue; }
    /* region -> weights; spread -> ladder usability. Both recorded per row. */
    const region = ZONE_REGION[zid] || STATE_REGION[(STATES[zid] || "")] || "DEFAULT";
    const prof = PROFILES[region] || PROFILES.DEFAULT;
    const policy = {};
    const sp = (byModel.Y && byModel.Y.p90Spread) || {};
    for (const row in (byModel.Y ? byModel.Y.rows : {})) {
      const lim = MAX_SPREAD[row];
      const obs = sp[row];
      const deg = byModel.Y.rows[row].degenerate ||
        Object.keys(byModel.Y.perStation || {}).some(st => (byModel.Y.perStation[st][row] || {}).degenerate);
      let ladder = "percentile", why = null;
      if (deg) { ladder = "absolute"; why = "percentiles degenerate at the danger end (cured floor)"; }
      else if (lim != null && obs != null && obs > lim) {
        ladder = "absolute";
        why = "station spread at p90 is " + obs + ", over the " + lim + " limit — a blended ladder would describe no station";
      }
      policy[row] = { weight: prof[row] != null ? prof[row] : 0, ladder, spread: obs != null ? obs : null, reason: why };
    }
    const doc = { schema: "fpb-fuels-climo-2", region, profile: region,
      policy, zone: { id: zid, name: Z.name },
      source: "FEMS climatology percentileLevels", api: API,
      span: { startYear: +Y0, endYear: +Y1 }, season: SEASON,
      window: { startMonthDay: MD0, endMonthDay: MD1, startHour: 0, endHour: 24 },
      percentiles: PCTS.split(",").map(Number).sort((a, b) => a - b),
      stations: Z.stations.map(x => ({ id: x, name: STN_NAMES[x] || null })),
      blend: Z.stations.length > 1 ? "mean-of-station-percentiles (approximation)" : "single-station (exact)",
      fetched_at: new Date().toISOString(), errs,
      models: byModel };
    fs.writeFileSync(path.join(OUT, zid + ".json"), JSON.stringify(doc, null, 1));
    const yS = byModel.Y && byModel.Y.p90Spread;
    if (yS && Z.stations.length > 1) {
      const worst = Object.keys(yS).sort((a, b) => yS[b] - yS[a]).slice(0, 3)
        .map(r => r + " \u00b1" + yS[r]).join("  ");
      console.log("   station spread at p90 (max-min):", worst);
      if ((yS.erc || 0) > 8) console.log("   \u26a0 ERC p90 spread > 8 \u2014 this zone may not be coherent enough for one blended set");
    }
    const abs = Object.keys(policy).filter(r => policy[r].ladder === "absolute");
    console.log("   region", region, "\u00b7 KBDI weight", prof.kbdi,
      abs.length ? ("\u00b7 absolute fallback: " + abs.join(", ")) : "\u00b7 all rows on percentiles");
    const y = byModel.Y && byModel.Y.rows.erc;
    console.log(zid, "✓", Z.stations.map(x => STN_NAMES[x] || x).join(" + "), "·", Object.keys(byModel).join("/"),
      y ? ("· ERC p80 " + y.p80 + " p90 " + y.p90 + " p97 " + y.p97) : "",
      errs.length ? ("· " + errs.length + " errors") : "");
  }
  console.log("\nwrote to", OUT);
}
main().catch(e => { console.error(e); process.exit(1); });
