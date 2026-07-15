"use strict";
/* Minimal ESRI shapefile (.shp) + dBASE (.dbf) readers — polygons only.
   Supports shape types 5 (Polygon), 15 (PolygonZ), 25 (PolygonM); Z/M
   payloads that trail the XY points are ignored. No dependencies. */

function readShp(buf){
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getInt32(0, false) !== 9994) throw new Error("not a shapefile (bad magic)");
  const fileLenBytes = dv.getInt32(24, false) * 2;
  const out = [];
  let off = 100;
  while (off + 8 <= fileLenBytes && off + 8 <= buf.byteLength){
    const recNo = dv.getInt32(off, false);
    const contentBytes = dv.getInt32(off + 4, false) * 2;
    const body = off + 8;
    const type = dv.getInt32(body, true);
    if (type === 0){ out.push({ recNo, type, parts: [] }); off = body + contentBytes; continue; }
    if (type !== 5 && type !== 15 && type !== 25){
      throw new Error("record " + recNo + ": unsupported shape type " + type + " (polygons only)");
    }
    const numParts = dv.getInt32(body + 36, true);
    const numPoints = dv.getInt32(body + 40, true);
    const partsIdx = [];
    for (let i = 0; i < numParts; i++) partsIdx.push(dv.getInt32(body + 44 + i * 4, true));
    partsIdx.push(numPoints);
    const ptBase = body + 44 + numParts * 4;
    const parts = [];
    for (let p = 0; p < numParts; p++){
      const ring = [];
      for (let i = partsIdx[p]; i < partsIdx[p + 1]; i++){
        ring.push([dv.getFloat64(ptBase + i * 16, true), dv.getFloat64(ptBase + i * 16 + 8, true)]);
      }
      parts.push(ring);
    }
    out.push({ recNo, type, parts });
    off = body + contentBytes;
  }
  return out;
}

function readDbf(buf){
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const numRec = dv.getUint32(4, true);
  const headerLen = dv.getUint16(8, true);
  const recLen = dv.getUint16(10, true);
  const fields = [];
  let off = 32;
  while (off < headerLen - 1 && buf[off] !== 0x0D){
    let name = "";
    for (let i = 0; i < 11 && buf[off + i] !== 0; i++) name += String.fromCharCode(buf[off + i]);
    fields.push({ name: name.trim(), type: String.fromCharCode(buf[off + 11]), len: buf[off + 16] });
    off += 32;
  }
  const rows = [];
  let rec = headerLen;
  for (let r = 0; r < numRec; r++, rec += recLen){
    if (rec + recLen > buf.byteLength) break;
    const row = { _deleted: buf[rec] === 0x2A };
    let f = rec + 1;
    for (const fd of fields){
      const raw = buf.slice(f, f + fd.len).toString("latin1").trim();
      row[fd.name] = (fd.type === "N" || fd.type === "F")
        ? (raw === "" ? null : parseFloat(raw)) : raw;
      f += fd.len;
    }
    rows.push(row);
  }
  return { fields: fields.map(x => x.name), rows };
}

/* Shoelace signed area: shapefile spec stores OUTER rings clockwise
   (negative signed area with the standard formula), holes counter-clockwise. */
function signedArea(ring){
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++){
    s += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
  }
  return s / 2;
}
function pointInRing(x, y, ring){
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++){
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
/* Group a record's rings into [{outer, holes[]}]. Holes attach to the outer
   that contains their first vertex; orphans are promoted to outers (defensive). */
function groupPolygons(parts){
  const outers = [], holes = [];
  for (const ring of parts){
    if (ring.length < 4) continue;
    (signedArea(ring) < 0 ? outers : holes).push(ring);
  }
  if (!outers.length){ return holes.map(h => ({ outer: h, holes: [] })); }
  const polys = outers.map(o => ({ outer: o, holes: [] }));
  for (const h of holes){
    const host = polys.find(p => pointInRing(h[0][0], h[0][1], p.outer));
    if (host) host.holes.push(h); else polys.push({ outer: h, holes: [] });
  }
  return polys;
}

module.exports = { readShp, readDbf, signedArea, pointInRing, groupPolygons };
