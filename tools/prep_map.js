#!/usr/bin/env node
"use strict";
/* =========================================================================
   FPB — tools/prep_map.js (v1)
   NWS fire-weather-zone shapefile → simplified GeoJSON for the map.
   Same input discovery and zone-id logic as prep_zones.js, so the ids
   match zones_points.csv and the climo files exactly.

   Pipeline per zone: merge split records → quantize coords (snaps shared
   borders so neighbors keep identical vertices) → Douglas-Peucker per ring
   → drop degenerate rings → Feature with {id, name, st} properties.

   Usage:
     node tools/prep_map.js [--shp input/xx.shp] [--out data/zones.geojson]
                            [--tolerance 0.008] [--quant 4]
   Defaults discover the largest .shp in ./input like prep_zones.js.
   Tolerance is in degrees (~0.008 ≈ 0.9 km): borders between independently
   simplified neighbors can gap by up to that much at high zoom — invisible
   at national scale, cosmetic at zone scale, tune down if it bothers you.
   ========================================================================= */
const fs = require("fs");
const path = require("path");
function findLib(){
  const cands = [path.join(__dirname, "..", "lib"), path.join(__dirname, "lib"),
    path.join(process.cwd(), "lib")].filter(p => fs.existsSync(path.join(p, "shp.js")));
  if (!cands.length) throw new Error("lib/shp.js not found — run from the climo-fetcher folder or copy lib/ beside tools/");
  return cands[0];
}
const { readShp, readDbf, groupPolygons } = require(path.join(findLib(), "shp.js"));

function arg(name, def){ const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; }
const TOL   = +arg("tolerance", 0.008);
const QUANT = Math.max(0, +arg("quant", 4));
const OUT   = arg("out", path.join("data", "zones.geojson"));

function findShapefile(){
  const given = arg("shp", null);
  if (given){
    const dbf = given.replace(/\.shp$/i, ".dbf");
    if (!fs.existsSync(given) || !fs.existsSync(dbf)) throw new Error("shp/dbf pair not found at " + given);
    return { shp: given, dbf, name: path.basename(given) };
  }
  const dir = "input";
  const files = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(f => f.toLowerCase().endsWith(".shp"));
  if (!files.length) throw new Error("no .shp found — pass --shp path\\to\\file.shp or use ./input");
  files.sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size);
  const shp = path.join(dir, files[0]);
  return { shp, dbf: shp.replace(/\.shp$/i, ".dbf"), name: files[0] };
}
function zoneId(row){
  const st = String(row.STATE || "").trim().toUpperCase();
  let z = String(row.ZONE == null ? "" : row.ZONE).trim();
  if (!z && row.STATE_ZONE) z = String(row.STATE_ZONE).trim().replace(/^[A-Z]{2}Z?/i, "");
  z = z.replace(/\D/g, "").padStart(3, "0");
  if (!st || z === "000") return null;
  return st + "Z" + z;
}

/* ---------- geometry ---------- */
const q = v => { const m = Math.pow(10, QUANT); return Math.round(v * m) / m; };
function quantRing(ring){
  const out = [];
  for (const p of ring){
    const x = q(p[0]), y = q(p[1]);
    const last = out[out.length - 1];
    if (!last || last[0] !== x || last[1] !== y) out.push([x, y]);
  }
  return out;
}
function perpDist(p, a, b){
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  if (!L2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
/* iterative Douglas-Peucker (open polyline; caller manages ring closure) */
function dp(pts, tol){
  if (pts.length <= 2 || tol <= 0) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length){
    const [a, b] = stack.pop();
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++){
      const d = perpDist(pts[i], pts[a], pts[b]);
      if (d > worst){ worst = d; wi = i; }
    }
    if (worst > tol){ keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}
function simplifyRing(ring){
  let r = quantRing(ring);
  /* treat as closed: drop duplicate closing point for DP, restore after */
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r = r.slice(0, -1);
  if (r.length < 4) return null;
  r = dp(r.concat([r[0]]), TOL);           /* anchor both ends at the same vertex */
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r = r.slice(0, -1);
  if (r.length < 3) return null;
  r.push([r[0][0], r[0][1]]);              /* GeoJSON closure */
  return r;
}

function main(){
  const src = findShapefile();
  console.log("reading " + src.name);
  const shp = readShp(fs.readFileSync(src.shp));
  const dbf = readDbf(fs.readFileSync(src.dbf));
  if (shp.length !== dbf.rows.length) throw new Error("shp/dbf record count mismatch");

  /* merge split zones exactly like prep_zones */
  const zones = new Map(); let skipped = 0;
  for (let i = 0; i < shp.length; i++){
    const row = dbf.rows[i];
    if (row._deleted) continue;
    const id = zoneId(row);
    if (!id){ skipped++; continue; }
    if (!zones.has(id)) zones.set(id, { id, st: id.slice(0, 2),
      name: String(row.NAME || row.SHORTNAME || "").trim(), parts: [] });
    zones.get(id).parts.push.apply(zones.get(id).parts, shp[i].parts);
  }

  let vIn = 0, vOut = 0, ringsDropped = 0;
  const feats = [];
  for (const z of zones.values()){
    for (const p of z.parts) vIn += p.length;
    const polys = groupPolygons(z.parts);
    const coords = [];
    for (const poly of polys){
      const outer = simplifyRing(poly.outer);
      if (!outer){ ringsDropped++; continue; }
      const rings = [outer];
      for (const h of poly.holes){
        const hr = simplifyRing(h);
        if (hr) rings.push(hr); else ringsDropped++;
      }
      coords.push(rings);
    }
    if (!coords.length){ console.log("WARN " + z.id + ": all rings degenerate — zone omitted"); continue; }
    for (const poly of coords) for (const r of poly) vOut += r.length;
    feats.push({ type: "Feature",
      properties: { id: z.id, name: z.name, st: z.st },
      geometry: coords.length === 1
        ? { type: "Polygon", coordinates: coords[0] }
        : { type: "MultiPolygon", coordinates: coords } });
  }
  feats.sort((a, b) => a.properties.id < b.properties.id ? -1 : 1);
  const fc = { type: "FeatureCollection", features: feats };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const json = JSON.stringify(fc);
  fs.writeFileSync(OUT, json);
  const mb = (json.length / 1048576).toFixed(1);
  console.log("zones: " + feats.length + " (skipped no-id records: " + skipped + ", degenerate rings dropped: " + ringsDropped + ")");
  console.log("vertices: " + vIn.toLocaleString() + " -> " + vOut.toLocaleString() +
    " (" + (100 * vOut / Math.max(1, vIn)).toFixed(1) + "%) · tolerance " + TOL + "° · quant " + QUANT + "dp");
  console.log("wrote " + OUT + " (" + mb + " MB)");
  if (json.length > 45 * 1048576) console.log("NOTE: >45 MB — consider raising --tolerance (e.g. 0.012) before committing");
}
main();
