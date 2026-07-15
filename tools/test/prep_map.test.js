"use strict";
/* Offline test for prep_map.js: builds a synthetic .shp/.dbf pair in /tmp,
   runs the tool, and asserts on the emitted GeoJSON:
     - ids merge and match prep_zones semantics (ORZ001 …)
     - two zones sharing a border keep IDENTICAL vertices along it (quantize snap)
     - a jagged-but-straight edge collapses under Douglas-Peucker
     - holes survive; degenerate sliver rings drop; split zones merge to MultiPolygon
*/
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const WORK = "/tmp/prep_map_t"; fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, "input"), { recursive: true });
let pass = 0, fail = 0;
const ck = (n, c) => { if (c) pass++; else { fail++; console.log("FAIL", n); } };

/* ---------- minimal shapefile writers (mirror lib/shp.js reader) ---------- */
function shpBuffer(recs){ /* recs: [ [ring,ring…] ] each ring = [[x,y]…] */
  const bodies = recs.map(parts => {
    const numPoints = parts.reduce((a, r) => a + r.length, 0);
    const len = 4 + 32 + 4 + 4 + 4 * parts.length + 16 * numPoints;
    const b = Buffer.alloc(len);
    b.writeInt32LE(5, 0);
    let xs = [], ys = [];
    parts.forEach(r => r.forEach(p => { xs.push(p[0]); ys.push(p[1]); }));
    b.writeDoubleLE(Math.min(...xs), 4); b.writeDoubleLE(Math.min(...ys), 12);
    b.writeDoubleLE(Math.max(...xs), 20); b.writeDoubleLE(Math.max(...ys), 28);
    b.writeInt32LE(parts.length, 36); b.writeInt32LE(numPoints, 40);
    let off = 44, idx = 0;
    for (const r of parts){ b.writeInt32LE(idx, off); off += 4; idx += r.length; }
    for (const r of parts) for (const p of r){ b.writeDoubleLE(p[0], off); b.writeDoubleLE(p[1], off + 8); off += 16; }
    return b;
  });
  const total = 100 + bodies.reduce((a, b) => a + 8 + b.length, 0);
  const out = Buffer.alloc(total);
  out.writeInt32BE(9994, 0); out.writeInt32BE(total / 2, 24); out.writeInt32LE(1000, 28); out.writeInt32LE(5, 32);
  let off = 100;
  bodies.forEach((b, i) => {
    out.writeInt32BE(i + 1, off); out.writeInt32BE(b.length / 2, off + 4);
    b.copy(out, off + 8); off += 8 + b.length;
  });
  return out;
}
function dbfBuffer(rows){ /* fields: STATE C2, ZONE C3, NAME C24 */
  const fields = [["STATE", 2], ["ZONE", 3], ["NAME", 24]];
  const recLen = 1 + fields.reduce((a, f) => a + f[1], 0);
  const headerLen = 32 + fields.length * 32 + 1;
  const out = Buffer.alloc(headerLen + rows.length * recLen + 1);
  out[0] = 3; out.writeUInt32LE(rows.length, 4);
  out.writeUInt16LE(headerLen, 8); out.writeUInt16LE(recLen, 10);
  let off = 32;
  for (const [nm, len] of fields){
    out.write(nm, off, "ascii"); out[off + 11] = "C".charCodeAt(0); out[off + 16] = len; off += 32;
  }
  out[off] = 0x0D;
  let rec = headerLen;
  for (const r of rows){
    out[rec] = 0x20; let f = rec + 1;
    for (const [nm, len] of fields){ out.write(String(r[nm] || "").padEnd(len).slice(0, len), f, "ascii"); f += len; }
    rec += recLen;
  }
  out[out.length - 1] = 0x1A;
  return out;
}

/* ---------- fixture geometry ---------- */
const sq = (x0, y0, x1, y1) => [[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]]; /* CW = shapefile outer */
/* ORZ001 and ORZ002 share the x=-117 edge; ORZ001's shared edge carries extra
   collinear jitter vertices (sub-quantum wiggle) that must collapse. */
const jaggedEdge = []; for (let i = 0; i <= 20; i++) jaggedEdge.push([-117 + (i % 2 ? 0.00003 : 0), 45 + i * 0.05]);
const z1 = [[-118, 45]].concat(jaggedEdge.map(p => [p[0], p[1]])).concat([[-117, 46], [-118, 46], [-118, 45]]);
const z2 = sq(-117, 45, -116, 46);
const hole = sq(-115.7, 45.3, -115.3, 45.7).slice().reverse();       /* CCW = hole */
const z3outer = sq(-115.9, 45.1, -115.1, 45.9);
const sliver = [[-115.05, 45.05], [-115.049999, 45.05], [-115.05, 45.050001], [-115.05, 45.05]];
const z4a = sq(-114.9, 45.1, -114.5, 45.5);                           /* split zone, part 1 */
const z4b = sq(-114.4, 45.1, -114.0, 45.5);                           /* split zone, part 2 */

fs.writeFileSync(path.join(WORK, "input", "test.shp"),
  shpBuffer([[z1], [z2], [z3outer, hole, sliver], [z4a], [z4b]]));
fs.writeFileSync(path.join(WORK, "input", "test.dbf"), dbfBuffer([
  { STATE: "OR", ZONE: "1", NAME: "Jagged West" },
  { STATE: "OR", ZONE: "2", NAME: "Neighbor East" },
  { STATE: "WA", ZONE: "3", NAME: "Holey" },
  { STATE: "ID", ZONE: "44", NAME: "Split A" },
  { STATE: "ID", ZONE: "44", NAME: "Split A" }
]));

/* ---------- run ---------- */
const TOOL = path.join(__dirname, "..", "prep_map.js");
const out = execFileSync("node", [TOOL, "--tolerance", "0.008", "--quant", "4"],
  { cwd: WORK, encoding: "utf8" });
if (process.env.VERBOSE) console.log(out);
const fc = JSON.parse(fs.readFileSync(path.join(WORK, "data", "zones.geojson"), "utf8"));

ck("feature-count", fc.features.length === 4);
const byId = {}; fc.features.forEach(f => byId[f.properties.id] = f);
ck("ids", !!byId.ORZ001 && !!byId.ORZ002 && !!byId.WAZ003 && !!byId.IDZ044);
ck("names", byId.ORZ001.properties.name === "Jagged West" && byId.ORZ001.properties.st === "OR");

/* DP collapsed the 21-vertex jitter edge: ORZ001 outer should be tiny now */
const r1 = byId.ORZ001.geometry.coordinates[0];
ck("jagged-collapsed", r1.length <= 7);
ck("ring-closed", r1[0][0] === r1[r1.length - 1][0] && r1[0][1] === r1[r1.length - 1][1]);

/* shared border: every ORZ001 vertex at x=-117 must exist verbatim in ORZ002 */
const r2 = byId.ORZ002.geometry.coordinates[0];
const set2 = new Set(r2.map(p => p.join(",")));
const shared1 = r1.filter(p => p[0] === -117);
ck("shared-edge-has-vertices", shared1.length >= 2);
ck("shared-edge-snapped", shared1.every(p => set2.has(p.join(","))));

/* hole survives, sliver dropped */
ck("hole-kept", byId.WAZ003.geometry.coordinates.length === 2);
ck("sliver-dropped", /degenerate rings dropped: 1/.test(out));

/* split zone merged to MultiPolygon */
ck("split-merged", byId.IDZ044.geometry.type === "MultiPolygon" && byId.IDZ044.geometry.coordinates.length === 2);

/* vertex accounting printed */
ck("stats-line", /vertices: .* -> /.test(out));

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
