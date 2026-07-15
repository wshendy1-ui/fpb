#!/usr/bin/env node
/* =========================================================================
   FPB — rate_national.js (v1.1)
   Daily national zone ratings: forecast (Open-Meteo, single model, batched
   multi-point) × precomputed climatology (climo-fetcher output) → per-zone
   per-day composite tier via the extracted v83 engine.

   NATIONAL v1 COMPOSITE (weather-anomaly + dry-lightning, per design):
     tmax / rhmin / rhrec ....... devSev (sigma vs zone normals)   w = THR_DEF
     wind / gust / pop .......... sevFromThr (absolute ladders)     w = THR_DEF
     dry lightning .............. CAPE path (no NWS PoT nationally) w = W_DRY
   NOT in national v1 (deep-dive only → "REFINED" badge): HDW, Haines,
   FFWI/VPD, LAL/PoT, RFW alerts, all FEMS fuels rows.

   Usage:
     node rate_national.js --zones data/zones_points.csv --climo climo \
          --out ratings [--model gfs_seamless] [--batch 40] [--limit N]
          [--states OR,WA] [--days 7]
   Env: OM_API_KEY (or .env alongside), OM_BASE (tests: mock server URL)
   v1.1: batch-failure reasons logged; 429s retry the same batch (max 4,
   backoff --backoff429 ms) and sustained 429 aborts WITHOUT writing output
   (yesterday's latest.json stays live); size-mismatch responses fall back
   to singles instead of looping.
   ========================================================================= */
"use strict";
const fs = require("fs");
const path = require("path");

/* ---------- locate engine ---------- */
function findEngine(){
  const cands = [process.env.ENGINE_DIR,
    path.join(__dirname, "..", "engine"),
    path.join(__dirname, "engine")].filter(Boolean);
  for (const c of cands) if (fs.existsSync(path.join(c, "core.js"))) return c;
  throw new Error("engine not found; set ENGINE_DIR or place engine/ beside cron/");
}
const ENG = findEngine();
const C = require(path.join(ENG, "core.js"));
const S = require(path.join(ENG, "sources.js"));

/* ---------- args + env ---------- */
function arg(name, def){ const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; }
function loadEnv(){
  const p = path.join(process.cwd(), ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)){
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}
loadEnv();
const ZONES_CSV = arg("zones", "data/zones_points.csv");
const CLIMO_DIR = arg("climo", "climo");
const OUT_DIR   = arg("out", "ratings");
const MODEL     = arg("model", "gfs_seamless");
const BATCH     = Math.max(1, +arg("batch", 40));
const LIMIT     = +arg("limit", 0);
const STATES    = (arg("states", "") || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
const NDAYS     = Math.min(7, Math.max(1, +arg("days", 7)));
const BACKOFF   = Math.max(0, +arg("backoff429", 60000));
const errStr = e => String((e && e.message) || e).slice(0, 140);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* trimmed request — everything the national v1 composite consumes, nothing more */
const HOURLY_TRIM = ["relative_humidity_2m", "cape"];              /* rhmin+rhrec, dry-ltg */
const DAILY_TRIM  = ["temperature_2m_max", "precipitation_sum",
  "precipitation_probability_max", "wind_speed_10m_max", "wind_gusts_10m_max"];

/* ---------- inputs ---------- */
function readZones(){
  const txt = fs.readFileSync(ZONES_CSV, "utf8").trim();
  const lines = txt.split(/\r?\n/);
  const hdr = lines[0].split(",").map(h => h.trim().toLowerCase());
  const ix = { id: hdr.indexOf("id"), lat: hdr.indexOf("lat"), lon: hdr.indexOf("lon") };
  if (ix.id < 0 || ix.lat < 0 || ix.lon < 0) throw new Error("zones csv needs id,lat,lon columns");
  const out = [];
  for (let i = 1; i < lines.length; i++){
    const c = lines[i].split(",");
    const id = (c[ix.id] || "").trim();
    if (!id) continue;
    if (STATES.length && !STATES.includes(id.slice(0, 2))) continue;
    out.push({ id, lat: +c[ix.lat], lon: +c[ix.lon] });
  }
  return out;
}
function loadClimo(id){
  const p = path.join(CLIMO_DIR, id + ".json");
  if (!fs.existsSync(p)) return null;
  try { const j = JSON.parse(fs.readFileSync(p, "utf8")); return j.wxNormals || null; }
  catch (e) { return null; }
}

/* ---------- rating ---------- */
/* one zone-day of parsed fields -> {tier, score, dl, drv} */
function rateDay(d, dayKey, normals){
  const entries = [
    { id: "tmax",  s: C.devSev("tmax",  d.tmax,  dayKey, normals), w: C.THR_DEF.tmax.w },
    { id: "rhmin", s: C.devSev("rhmin", d.rhmin, dayKey, normals), w: C.THR_DEF.rhmin.w },
    { id: "rhrec", s: C.devSev("rhrec", d.rhrec, dayKey, normals), w: C.THR_DEF.rhrec.w },
    { id: "wind",  s: C.sevFromThr(d.wind, C.THR_DEF.wind.t, C.THR_DEF.wind.asc), w: C.THR_DEF.wind.w },
    { id: "gust",  s: C.sevFromThr(d.gust, C.THR_DEF.gust.t, C.THR_DEF.gust.asc), w: C.THR_DEF.gust.w },
    { id: "pop",   s: C.sevFromThr(d.pop,  C.THR_DEF.pop.t,  C.THR_DEF.pop.asc),  w: C.THR_DEF.pop.w },
    { id: "dryltg", s: C.dryLightning(d).v, w: C.W_DRY }
  ];
  const sc = C.scoreContribs(entries);
  let drv = "", best = 0;
  for (const c of sc.contrib) if (c.s >= 2 && c.c > best){ best = c.c; drv = c.id; }
  return {
    tier: C.adjLevel(sc.score),
    score: sc.score == null ? null : Math.round(sc.score * 100) / 100,
    dl: C.dryLightning(d).v || 0,
    drv
  };
}
function rateZone(zone, omResp, normals){
  const one = S.parseOmOne(omResp);
  const days = one.days.slice(0, NDAYS);
  const t = [], s = [], dl = [], drv = [];
  for (const k of days){
    const r = rateDay(one.d[k] || {}, k, normals);
    t.push(r.tier); s.push(r.score); dl.push(r.dl); drv.push(r.drv);
  }
  return { days, rec: { t, s, dl, drv } };
}

/* ---------- fetch (batched, singles fallback) ---------- */
async function fetchBatch(cfg, zones, drop){
  const resp = await S.omFetch(fetch, cfg, zones, MODEL, drop);
  return Array.isArray(resp) ? resp : [resp];
}
async function run(){
  const t0 = Date.now();
  const all = readZones();
  const zones = [], noClimo = [];
  for (const z of all){
    const N = loadClimo(z.id);
    if (N) { z.normals = N; zones.push(z); } else noClimo.push(z.id);
    if (LIMIT && zones.length >= LIMIT) break;
  }
  console.log("zones in csv: " + all.length + " | with climo: " + zones.length + " | skipped (no climo): " + noClimo.length);
  if (!zones.length) throw new Error("no zones with climatology found under " + CLIMO_DIR);

  const cfg = { key: (process.env.OM_API_KEY || "").trim() || undefined,
                base: process.env.OM_BASE || undefined,
                hourly: HOURLY_TRIM, daily: DAILY_TRIM };
  console.log("endpoint: " + S.omBaseEff(cfg) + (cfg.key ? " (key detected)" : " (FREE TIER)") + " | model: " + MODEL + " | batch: " + BATCH);

  const drop = [];
  const out = {}; const failed = [];
  let calls = 0; let daysRef = null;
  const nb = Math.ceil(zones.length / BATCH);
  for (let i = 0; i < zones.length; i += BATCH){
    const bi = Math.floor(i / BATCH) + 1;
    const batch = zones.slice(i, i + BATCH);
    let resps = null, lastErr = null, tries = 0, r429 = 0;
    while (!resps){
      try { calls++; resps = await fetchBatch(cfg, batch, drop); }
      catch (e){
        lastErr = e;
        if (/429/.test(String(e))){
          if (++r429 > 4) throw new Error("sustained 429 rate limiting — aborting run to protect quota; ratings NOT written (yesterday's latest.json remains live). Rerun later.");
          console.log("\n429 on batch " + bi + "/" + nb + " — backing off " + Math.round(BACKOFF / 1000) + "s (retry " + r429 + "/4)");
          await sleep(BACKOFF);
        } else if (++tries >= 2){ resps = "FALLBACK"; }
        else await sleep(3000);
      }
    }
    if (resps !== "FALLBACK" && resps.length !== batch.length){
      console.log("\nWARN batch " + bi + "/" + nb + " size mismatch (" + resps.length + "/" + batch.length + ") — singles fallback");
      resps = "FALLBACK"; lastErr = lastErr || new Error("size mismatch");
    }
    if (resps === "FALLBACK"){
      /* one bad point shouldn't kill the batch — try each zone alone */
      console.log("\nbatch " + bi + "/" + nb + " failed (" + errStr(lastErr) + ") — singles fallback");
      for (const z of batch){
        try { calls++; const r = await fetchBatch(cfg, [z], drop);
          const { days, rec } = rateZone(z, r[0], z.normals);
          daysRef = daysRef || days; out[z.id] = rec;
        } catch (e){
          if (/429/.test(String(e))) throw new Error("429 during singles fallback — aborting run to protect quota; ratings NOT written. Rerun later.");
          failed.push(z.id);
          if (failed.length <= 10) console.log("  zone " + z.id + " failed: " + errStr(e));
        }
        await sleep(250);
      }
    } else {
      batch.forEach((z, j) => {
        try { const { days, rec } = rateZone(z, resps[j], z.normals);
          daysRef = daysRef || days; out[z.id] = rec;
        } catch (e){ failed.push(z.id); if (failed.length <= 10) console.log("\n  zone " + z.id + " parse failed: " + errStr(e)); }
      });
    }
    process.stdout.write("\r  rated " + Object.keys(out).length + "/" + zones.length + " (" + calls + " calls)   ");
    await sleep(300);
  }
  console.log("");

  const doc = {
    schema: "fpb-national-1",
    generated: new Date().toISOString(),
    pointset_version: "poi-v1",
    model: MODEL,
    composite: "national-v1 (tmax/rhmin/rhrec sigma + wind/gust/pop abs + dry-ltg CAPE path)",
    days: daysRef || [],
    dropped_vars: drop.filter(x => typeof x === "string"),
    zones: out,
    failed: failed,
    no_climo: noClimo.length
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dated = path.join(OUT_DIR, (daysRef ? daysRef[0] : new Date().toISOString().slice(0, 10)) + ".json");
  fs.writeFileSync(dated, JSON.stringify(doc));
  fs.writeFileSync(path.join(OUT_DIR, "latest.json"), JSON.stringify(doc));
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log("rated " + Object.keys(out).length + " zones | failed " + failed.length + " | " + calls + " API calls | " + secs + "s");
  console.log("wrote " + dated + " and latest.json");
  if (failed.length) console.log("failed zones: " + failed.slice(0, 20).join(", ") + (failed.length > 20 ? " …" : ""));
  if (drop.length) console.log("self-heal dropped vars: " + drop.filter(x => typeof x === "string").join(", "));
}
run().catch(e => { console.error("\nFATAL: " + (e && e.message || e)); process.exit(1); });
