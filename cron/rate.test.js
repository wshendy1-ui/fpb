"use strict";
/* Offline end-to-end test for rate_national.js.
   Spins a mock Open-Meteo server, builds a small zone set that mixes REAL
   climo files (ORZ693, WYZ275) with synthetic ones, then asserts:
     - output schema + files
     - deterministic tiers hand-verified against engine math
     - zone with no climo file is skipped (counted, not failed)
     - a poisoned batch falls back to singles; only the bad zone fails
     - self-heal variable drop path still works through the cron config
     - 429s retry the SAME batch with backoff (no singles spray, no crash)
     - a size-mismatch response falls back to singles (no infinite loop) */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const C = require("../../engine/core.js");
let CHILD_OUT = "";

const WORK = "/tmp/cron_e2e";
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, "data"), { recursive: true });
fs.mkdirSync(path.join(WORK, "climo"), { recursive: true });

let pass = 0, fail = 0;
const ck = (n, c) => { if (c) pass++; else { fail++; console.log("FAIL", n); } };

/* ---------- fixture zones ---------- */
const Z = [
  /* COMMA1 added via CSV_ROWS with lat 45.9 lon -117.9 */
  { id: "ORZ693", lat: 45.72, lon: -117.20 },   /* real climo (uploaded) */
  { id: "WYZ275", lat: 44.02, lon: -107.95 },   /* real climo (uploaded) */
  { id: "TST001", lat: 40.00, lon: -110.00 },   /* synthetic climo */
  { id: "TST002", lat: 41.00, lon: -111.00 },   /* synthetic climo */
  { id: "MISMAT", lat: 14.14, lon: -114.14 },   /* mock appends a bogus element on multi-loc calls */
  { id: "TST003", lat: 43.00, lon: -113.00 },   /* synthetic climo */
  { id: "NOCLIM", lat: 42.00, lon: -112.00 },   /* no climo -> skipped */
  { id: "BADPT",  lat: 13.13, lon: -113.13 }    /* mock 400s any call containing 13.13 */
];
/* CSV mirrors prep_zones column order (name BEFORE lon/lat) and quotes names —
   COMMA1 regression-tests the CAZ271/IDZ421/NVZ438 bug: a comma inside the
   quoted name must NOT shift the coordinate columns. BADCRD has lon in the
   lat column and must be skipped before any fetch. */
const CSV_ROWS = Z.map(z => [z.id, '"Zone ' + z.id + '"', z.lon, z.lat, "poi"].join(","));
CSV_ROWS.splice(2, 0, 'COMMA1,"Canyon Grassland, of Testing",-117.9,45.9,poi');
CSV_ROWS.push('BADCRD,"Broken Row",-113.9,-115.9,poi');
fs.writeFileSync(path.join(WORK, "data", "zones_points.csv"),
  "id,name,lon,lat,method\n" + CSV_ROWS.join("\n") + "\n");

fs.copyFileSync("/mnt/user-data/uploads/ORZ693.json", path.join(WORK, "climo", "ORZ693.json"));
fs.copyFileSync("/mnt/user-data/uploads/WYZ275.json", path.join(WORK, "climo", "WYZ275.json"));
function flatClimo(id, tmax, rhmin, rhmax){
  const ring = v => { const o = {}; for (let m = 1; m <= 12; m++) for (let d = 1; d <= 31; d++){
    const k = String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0"); o[k] = v; } return o; };
  return { schema: "fpb-climo-1", pointset_version: "poi-v1", zone: { id, name: id },
    wxNormals: { tmax: ring(tmax), tmaxSd: ring(5), rhmin: ring(rhmin), rhminSd: ring(5),
                 rhmax: ring(rhmax), rhmaxSd: ring(5) } };
}
fs.writeFileSync(path.join(WORK, "climo", "TST001.json"), JSON.stringify(flatClimo("TST001", 80, 25, 70)));
fs.writeFileSync(path.join(WORK, "climo", "TST002.json"), JSON.stringify(flatClimo("TST002", 80, 25, 70)));
fs.writeFileSync(path.join(WORK, "climo", "MISMAT.json"), JSON.stringify(flatClimo("MISMAT", 80, 25, 70)));
fs.writeFileSync(path.join(WORK, "climo", "COMMA1.json"), JSON.stringify(flatClimo("COMMA1", 80, 25, 70)));
fs.writeFileSync(path.join(WORK, "climo", "BADCRD.json"), JSON.stringify(flatClimo("BADCRD", 80, 25, 70)));
fs.writeFileSync(path.join(WORK, "climo", "TST003.json"), JSON.stringify(flatClimo("TST003", 80, 25, 70)));
/* BADPT gets climo so it survives to the fetch stage */
fs.writeFileSync(path.join(WORK, "climo", "BADPT.json"), JSON.stringify(flatClimo("BADPT", 80, 25, 70)));

/* ---------- deterministic per-zone forecasts ---------- */
const N693 = JSON.parse(fs.readFileSync(path.join(WORK, "climo", "ORZ693.json"))).wxNormals;
const DAYS = []; { const t0 = new Date("2026-07-15T12:00:00Z");
  for (let i = 0; i < 7; i++) DAYS.push(new Date(t0.getTime() + i * 864e5).toISOString().slice(0, 10)); }
const md = DAYS[0].slice(5);

/* per-zone scripted day-0 conditions; days 1-6 mild */
const SCRIPT = {
  ORZ693: { tmax: N693.tmax[md] + 2.0 * Math.max(N693.tmaxSd[md], C.MIN_SD.tmax),   /* +2σ hot */
            rhFloor: Math.max(1, N693.rhmin[md] - 2.0 * Math.max(N693.rhminSd[md], C.MIN_SD.rhmin)),
            cape: 1200, precip: 0, wind: 22, gust: 34, pop: 5 },
  WYZ275: { tmax: 75, rhFloor: 40, cape: 50, precip: 0.4, wind: 6, gust: 10, pop: 70 }, /* benign, wet */
  TST001: { tmax: 80, rhFloor: 25, cape: 50, precip: 0, wind: 3, gust: 8,  pop: 10 },   /* exactly normal */
  TST002: { tmax: 80, rhFloor: 25, cape: 600, precip: 0, wind: 3, gust: 8, pop: 10 },   /* normal + dry cape */
  COMMA1: { tmax: 80, rhFloor: 25, cape: 50, precip: 0, wind: 3, gust: 8, pop: 10 },
  MISMAT: { tmax: 80, rhFloor: 25, cape: 50, precip: 0, wind: 3, gust: 8, pop: 10 },
  TST003: { tmax: 80, rhFloor: 25, cape: 50, precip: 0, wind: 3, gust: 8, pop: 10 },
  BADPT:  { tmax: 80, rhFloor: 25, cape: 0, precip: 0, wind: 0, gust: 0, pop: 0 }
};
function omRespFor(lat, lon){
  let z = Z.find(q => Math.abs(q.lat - lat) < 1e-6 && Math.abs(q.lon - lon) < 1e-6);
  if (!z && Math.abs(lat - 45.9) < 1e-6) z = { id: "COMMA1" };
  const sc = SCRIPT[z.id];
  const time = []; for (const d of DAYS) for (let h = 0; h < 24; h++) time.push(d + "T" + String(h).padStart(2, "0") + ":00");
  const rh = time.map((t, i) => {
    const day = t.slice(0, 10), h = +t.slice(11, 13);
    const floor = day === DAYS[0] ? sc.rhFloor : 45;           /* day0 scripted, rest mild */
    return Math.round((90 - (90 - floor) * Math.exp(-Math.pow(h - 16, 2) / 30)) * 10) / 10;
  });
  const cape = time.map(t => (t.slice(0, 10) === DAYS[0] && +t.slice(11, 13) >= 12 && +t.slice(11, 13) <= 20) ? sc.cape : 0);
  const flat = (d0v, restv) => DAYS.map((d, i) => i === 0 ? d0v : restv);
  return {
    latitude: lat, longitude: lon, utc_offset_seconds: -25200,
    daily: { time: DAYS.slice(), temperature_2m_max: flat(sc.tmax, 75),
      precipitation_sum: flat(sc.precip, 0), precipitation_probability_max: flat(sc.pop, 20),
      wind_speed_10m_max: flat(sc.wind, 5), wind_gusts_10m_max: flat(sc.gust, 9) },
    hourly: { time, relative_humidity_2m: rh, cape }
  };
}

/* ---------- mock server ---------- */
let deny429 = 2;                       /* first two requests get rate-limited */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const lats = (u.searchParams.get("latitude") || "").split(",").map(Number);
  const lons = (u.searchParams.get("longitude") || "").split(",").map(Number);
  if (deny429-- > 0){
    res.writeHead(429, { "content-type": "application/json" });
    return res.end(JSON.stringify({ reason: "Minutely API request limit exceeded" }));
  }
  if (lats.some(v => Math.abs(v - 13.13) < 1e-6)){
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ reason: "point rejected by mock" }));
  }
  const body = lats.map((la, i) => omRespFor(la, lons[i]));
  if (lats.length > 1 && lats.some(v => Math.abs(v - 14.14) < 1e-6))
    body.push({ bogus: true });          /* size-mismatch fault injection */
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body.length === 1 ? body[0] : body));
});

server.listen(0, "127.0.0.1", () => {
  const base = "http://127.0.0.1:" + server.address().port + "/v1/forecast";
  const child = spawn("node", [path.join(__dirname, "..", "rate_national.js"),
    "--zones", "data/zones_points.csv", "--climo", "climo", "--out", "ratings", "--batch", "3", "--backoff429", "400"],
    { cwd: WORK, env: Object.assign({}, process.env, { OM_BASE: base, OM_API_KEY: "" }) });
  CHILD_OUT = ""; let errOut = "";
  child.stdout.on("data", d => CHILD_OUT += d);
  child.stderr.on("data", d => errOut += d);
  const killer = setTimeout(() => { console.log("child timeout"); child.kill("SIGKILL"); }, 60000);
  child.on("exit", code => {
    clearTimeout(killer);
    if (process.env.VERBOSE) console.log(CHILD_OUT, errOut);
    ck("script-exit-0", code === 0);
    if (code !== 0){ console.log(CHILD_OUT, errOut); }
    runAsserts();
  });
});
function runAsserts(){

  const latest = JSON.parse(fs.readFileSync(path.join(WORK, "ratings", "latest.json"), "utf8"));
  const dated = path.join(WORK, "ratings", DAYS[0] + ".json");
  ck("dated-file", fs.existsSync(dated));
  ck("schema", latest.pointset_version === "poi-v1");
  ck("days", JSON.stringify(latest.days) === JSON.stringify(DAYS));
  ck("noclim-skipped", latest.no_climo === 1 && !latest.zones.NOCLIM);
  ck("429-retried-same-batch", (CHILD_OUT.match(/429 on batch/g) || []).length === 2);
  ck("mismatch-fallback", /size mismatch \(4\/3\)/.test(CHILD_OUT));
  ck("reason-logged", /point rejected by mock/.test(CHILD_OUT));
  ck("mismat-zone-rated", !!latest.zones.MISMAT && latest.zones.MISMAT.s.every(v => v != null));
  ck("tst003-rated", !!latest.zones.TST003);
  ck("badpt-failed", latest.failed.length === 1 && latest.failed[0] === "BADPT");
  ck("batchmates-survived", !!latest.zones.TST001 && !!latest.zones.TST002 && !!latest.zones.WYZ275);
  ck("rated-count", Object.keys(latest.zones).length === 7);
  ck("comma-name-zone-rated", !!latest.zones.COMMA1 && latest.zones.COMMA1.t.every(v => v != null));
  ck("bad-coords-skipped", JSON.stringify(latest.bad_coords) === JSON.stringify(["BADCRD"]));
  ck("bad-coords-not-failed", latest.failed.indexOf("BADCRD") < 0);
  ck("schema-v2", latest.schema === "fpb-national-2" && latest.ladder === "v83-normalT2-wgE1");
  ck("weights-present", latest.weights && latest.weights.rhmin === 1.3 && latest.weights.dryltg === 1.1);
  ck("wx-day0-tmax", latest.zones.TST001.wx.tmax[0] === 80);
  ck("wx-cape", latest.zones.TST002.wx.cape[0] === 600);
  ck("wx-precip-rounded", latest.zones.WYZ275.wx.precip[0] === 0.4);
  ck("rows-shape", JSON.stringify(Object.keys(latest.zones.TST001.rows).sort()) ===
                   JSON.stringify(["gust","pop","rhmin","rhrec","tmax","wind"]));
  ck("rows-tst001-day0", latest.zones.TST001.rows.tmax[0] === 2 && latest.zones.TST001.rows.pop[0] === 3 &&
                         latest.zones.TST001.rows.rhrec[0] === 0);
  ck("rows-orz693-hot", latest.zones.ORZ693.rows.tmax[0] === 4 && latest.zones.ORZ693.rows.rhmin[0] === 4);

  /* hand-verified expectations, mirroring the engine math exactly */
  /* TST001 — everything at normal, calm, dry-but-no-cape:
     tmax/rhmin at normal -> T2,T2; rhrec better-than-normal -> T0; calm wind/gust -> 0,0 under E1 ; wind 3 -> 1 ; gust 8 -> 1 ; pop 10 -> 3 ; dryltg 0 (w>0 but s=0 counts) */
  {
    const e = [
      { id: "tmax", s: 2, w: C.THR_DEF.tmax.w }, { id: "rhmin", s: 2, w: C.THR_DEF.rhmin.w },
      { id: "rhrec", s: 0, w: C.THR_DEF.rhrec.w }, { id: "wind", s: 0, w: C.THR_DEF.wind.w },   /* 3 mph < 8 (E1) */
      { id: "gust", s: 0, w: C.THR_DEF.gust.w }, { id: "pop", s: 3, w: C.THR_DEF.pop.w },        /* 8 mph < 15 (E1) */
      { id: "dryltg", s: 0, w: C.W_DRY }
    ];
    const want = C.scoreContribs(e);
    ck("TST001-day0-score", Math.abs(latest.zones.TST001.s[0] - Math.round(want.score * 100) / 100) < 1e-9);
    ck("TST001-day0-tier", latest.zones.TST001.t[0] === C.adjLevel(want.score));
    ck("TST001-dl0", latest.zones.TST001.dl[0] === 0);
  }
  /* TST002 — same but CAPE 600 on a dry day -> dryltg MED T3 */
  ck("TST002-dl0", latest.zones.TST002.dl[0] === 3);
  ck("TST002-hotter-than-TST001", latest.zones.TST002.s[0] > latest.zones.TST001.s[0]);
  /* ORZ693 — +2σ hot, −2σ dry, CAPE 1200 dry, windy: expect top tier day 0 */
  ck("ORZ693-day0-T4", latest.zones.ORZ693.t[0] === 4);
  ck("ORZ693-dl0-4", latest.zones.ORZ693.dl[0] === 4);
  ck("ORZ693-driver", ["rhmin", "tmax", "dryltg", "gust", "wind"].includes(latest.zones.ORZ693.drv[0]));
  /* WYZ275 — cool wet: day-0 tier at or below its mild days */
  ck("WYZ275-benign", latest.zones.WYZ275.t[0] <= 2);
  /* mild days: every zone finite scores all 7 days */
  ck("all-days-scored", Object.values(latest.zones).every(z => z.s.length === 7 && z.s.every(v => v != null)));

  console.log(pass + " passed, " + fail + " failed");
  server.close();
  process.exit(fail ? 1 : 0);
}
