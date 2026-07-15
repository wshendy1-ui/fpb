"use strict";
/* Tests for fpb-map/index.html.
   Layer 1 — pure helpers: extracted from the page (config consts + [pure] block)
             and exercised at exact boundaries in plain node.
   Layer 2 — jsdom boot smoke: stub maplibregl + fetch + fixtures, eval the app
             script, assert the boot sequence, auto-select, scrub repaint,
             unrated-zone panel, and pin toggling. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const APP_JS = HTML.split("<script>").pop().split("</script>")[0];

let pass = 0, fail = 0;
const ck = (n, c) => { if (c) pass++; else { fail++; console.log("FAIL", n); } };
const eq = (n, a, b) => { ck(n, JSON.stringify(a) === JSON.stringify(b));
  if (JSON.stringify(a) !== JSON.stringify(b) && process.env.VERBOSE) console.log("  got:", JSON.stringify(a), "want:", JSON.stringify(b)); };

/* ================= Layer 1 — pure ================= */
{
  let pure = APP_JS.slice(0, APP_JS.indexOf("/* ================= [pure-end]"));
  pure = pure.replace('"use strict";', "").replace(/\bconst\b/g, "var").replace(/\blet\b/g, "var");
  const ctx = vm.createContext({ Date, Math, JSON, Array, String, Infinity, isNaN, parseFloat });
  vm.runInContext(pure, ctx);

  eq("tierColor", [ctx.tierColor(0), ctx.tierColor(4), ctx.tierColor(null), ctx.tierColor(-1)],
    [ctx.TIER_COLORS[0], ctx.TIER_COLORS[4], ctx.NODATA_COLOR, ctx.NODATA_COLOR]);
  eq("scoreTxt", [ctx.scoreTxt(null), ctx.scoreTxt(3.8269)], ["—", "3.83"]);
  {
    const now = Date.parse("2026-07-16T12:00:00Z");
    const at = h => new Date(now - h * 3600e3).toISOString();
    eq("age-ok", ctx.fmtAge(at(25.9), now).cls, "ok");
    eq("age-warn", ctx.fmtAge(at(26.1), now).cls, "warn");
    eq("age-bad", ctx.fmtAge(at(30.1), now).cls, "bad");
    eq("age-minutes", ctx.fmtAge(at(0.5), now).txt, "ratings 30m");
    eq("age-garbage", ctx.fmtAge("nope", now).cls, "bad");
  }
  eq("dayLabel-today", ctx.dayLabel("2026-07-15", 0), "Today");
  eq("dayLabel-dow", ctx.dayLabel("2026-07-16", 1), "Thu 16");
  eq("normalize", ["orz693", "or 693", "OR693", "wyz-275", "693", "ORZ0693"].map(ctx.normalizeZoneQuery),
    ["ORZ693", "ORZ693", "ORZ693", "WYZ275", null, null]);
  eq("fillExpr-day-indexed", ctx.fillExpr(3)[1][1][1], "t3");
  eq("dlFilter", ctx.dlFilter(2), [">=", ["coalesce", ["get", "dl2"], 0], ctx.DL_MIN]);
  {
    const feats = [
      { properties: { id: "ORZ693", name: "Canyon Grassland" },
        geometry: { type: "Polygon", coordinates: [[[-118, 45], [-118, 46], [-117, 46], [-117, 45], [-118, 45]]] } },
      { properties: { id: "XXZ999", name: "Unrated" },
        geometry: { type: "MultiPolygon", coordinates: [[[[-116, 45], [-116, 46], [-115, 46], [-115, 45], [-116, 45]]]] } }
    ];
    const zonesMap = { ORZ693: { t: [2, 3, 4, 1, 0, 2, 3], s: [1, 2, 3, 1, 0, 1, 2], dl: [0, 0, 4, 0, 0, 0, 0], drv: ["", "", "dryltg", "", "", "", ""] } };
    const j = ctx.joinRatings(feats, zonesMap, 7);
    eq("join-rated", j.rated, 1);
    eq("join-props", [feats[0].properties.t0, feats[0].properties.t2, feats[0].properties.dl2], [2, 4, 4]);
    ck("join-unrated-untouched", feats[1].properties.t0 === undefined);
    eq("join-centroid", j.centroids.ORZ693, [-117.5, 45.5]);
    eq("join-centroid-multi", j.centroids.XXZ999, [-115.5, 45.5]);
    const dl = ctx.dlPointsGeojson(j.centroids, zonesMap, 7);
    eq("dlpts", [dl.features.length, dl.features[0].properties.dl2], [1, 4]);
  }
  {
    const store = { v: null, getItem(){ return this.v; }, setItem(k, x){ this.v = x; } };
    eq("pins-seed", ctx.pinsLoad(store), ctx.PIN_SEED);
    store.v = JSON.stringify(["AAA111"]);
    eq("pins-stored", ctx.pinsLoad(store), ["AAA111"]);
    eq("pins-toggle", [ctx.pinsToggle(["A"], "B"), ctx.pinsToggle(["A", "B"], "A")], [["A", "B"], ["B"]]);
  }
}

{
  /* driver / inhibitor math on a hand-built record */
  let pure2 = APP_JS.slice(0, APP_JS.indexOf("/* ================= [pure-end]"));
  pure2 = pure2.replace('"use strict";', "").replace(/\bconst\b/g, "var").replace(/\blet\b/g, "var");
  const c2 = vm.createContext({ Date, Math, JSON, Array, String, Infinity, isNaN, parseFloat });
  vm.runInContext(pure2, c2);
  const W = { tmax:0.8, rhmin:1.3, rhrec:1.0, wind:1.2, gust:0.8, pop:0.4, dryltg:1.1 };
  const rec = { dl:[0,4], rows:{ tmax:[3,2], rhmin:[4,0], rhrec:[0,1], wind:[1,1], gust:[2,1], pop:[3,0] },
                wx:{ tmax:[95,80], rhmin:[11,40], rhrec:[52,80], wind:[8,4], gust:[14,8], pop:[5,60], cape:[150,900], precip:[0,0.2] } };
  const t0 = c2.topDrivers(rec, W, 0, 2);
  eq("top2-day0", t0.map(d=>d.id), ["rhmin","tmax"]);               /* 5.2, 2.4 beat gust 1.6, pop 1.2 */
  const t1 = c2.topDrivers(rec, W, 1, 2);
  eq("top2-day1-dryltg", t1.map(d=>d.id), ["dryltg","tmax"]);       /* 4.4 dl, 1.6 tmax */
  const inh = c2.inhibitor(rec, W, 1);
  eq("inhibitor-day1", [inh.id, Math.round(inh.sc*10)/10], ["rhmin", 2.6]);  /* rhmin s0 w1.3 */
  eq("inhibitor-skips-dryltg", c2.inhibitor({ dl:[0], rows:{ tmax:[2] } }, W, 0), null);
  eq("drv-value", [c2.drvValueTxt("rhmin", rec, 0), c2.drvValueTxt("dryltg", rec, 1), c2.drvValueTxt("tmax", { }, 0)],
                  ["11%", "CAPE 900", ""]);
  eq("drivers-null-on-v1", c2.topDrivers({ t:[1], dl:[0] }, W, 0, 2), null);
}

/* ================= Layer 2 — jsdom boot smoke ================= */
const DAYS = ["2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21"];
const FIX_RATINGS = {
  schema: "fpb-national-2", generated: new Date().toISOString(), pointset_version: "poi-v1",
  model: "gfs_seamless", days: DAYS, ladder: "v83-normalT2",
  weights: { tmax:0.8, rhmin:1.3, rhrec:1.0, wind:1.2, gust:0.8, pop:0.4, dryltg:1.1 },
  zones: {
    ORZ693: { t: [2, 3, 4, 1, 0, 2, 3], s: [1.5, 2.2, 3.4, 0.9, 0.4, 1.5, 2.1], dl: [0, 0, 4, 0, 0, 0, 0],
      drv: ["rhmin", "tmax", "dryltg", "", "", "rhmin", "wind"],
      rows: { tmax:  [3, 3, 4, 1, 1, 2, 3],
              rhmin: [4, 3, 4, 1, 0, 2, 3],
              rhrec: [2, 2, 3, 1, 1, 2, 2],
              wind:  [1, 2, 3, 1, 1, 1, 2],
              gust:  [1, 2, 3, 1, 1, 1, 2],
              pop:   [3, 3, 3, 0, 0, 3, 3] },
      wx: { tmax:[95,97,101,84,78,90,94], rhmin:[11,13,9,32,45,20,15], rhrec:[52,48,40,75,88,60,55],
            wind:[8,12,18,6,5,7,11], gust:[14,22,31,10,9,13,19], pop:[5,10,5,55,70,10,8],
            cape:[150,300,1200,400,100,200,250], precip:[0,0,0,0.25,0.4,0,0] } },
    WYZ275: { t: [1, 1, 2, 2, 3, 2, 1], s: [0.9, 1.0, 1.6, 1.7, 2.3, 1.6, 1.1], dl: [0, 0, 0, 0, 3, 0, 0],
      drv: ["", "", "", "", "gust", "", ""] }   /* v1-shaped zone: no rows/wx — tolerance path */
  },
  failed: [], no_climo: 0, dropped_vars: [], bad_coords: []
};
const FIX_GEO = { type: "FeatureCollection", features: [
  { type: "Feature", properties: { id: "ORZ693", name: "Canyon Grassland of Wallowa County", st: "OR" },
    geometry: { type: "Polygon", coordinates: [[[-118, 45], [-118, 46], [-117, 46], [-117, 45], [-118, 45]]] } },
  { type: "Feature", properties: { id: "WYZ275", name: "North Bighorn Basin", st: "WY" },
    geometry: { type: "Polygon", coordinates: [[[-108.4, 43.7], [-108.4, 44.4], [-107.5, 44.4], [-107.5, 43.7], [-108.4, 43.7]]] } },
  { type: "Feature", properties: { id: "XXZ999", name: "No Rating Zone", st: "XX" },
    geometry: { type: "Polygon", coordinates: [[[-100, 40], [-100, 41], [-99, 41], [-99, 40], [-100, 40]]] } }
] };

const dom = new JSDOM(HTML.replace(/<script src="https:[^"]+"><\/script>/, "")
                          .replace(/<script>[\s\S]*<\/script>/, ""),   /* strip app script; eval manually */
  { runScripts: "outside-only", url: "https://example.test/" });
const w = dom.window;

class StubMap {
  constructor(o){ this.opts = o; this.layers = {}; this.sources = {}; this.filters = {};
    this.paints = []; this.handlers = {}; this.layout = [];
    /* real MapLibre exposes style-defined layers via getLayer — mirror that */
    if (o && o.style && o.style.layers) for (const l of o.style.layers) this.layers[l.id] = l; }
  on(ev, a, b){ const key = b ? ev + ":" + a : ev; const h = b || a;
    this.handlers[key] = h; if (ev === "load") h(); }
  addControl(){} addSource(id, d){ this.sources[id] = d; }
  addLayer(l){ this.layers[l.id] = l; }
  getLayer(id){ return this.layers[id]; }
  setPaintProperty(id, k, v){ this.paints.push([id, k, JSON.stringify(v)]); }
  setFilter(id, f){ this.filters[id] = f; }
  setLayoutProperty(id, k, v){ this.layout.push([id, k, v]); }
  addImage(id, img){ (this.images = this.images || []).push(id); }
  hasImage(id){ return (this.images || []).includes(id); }
  getCanvas(){ return { style: {} }; }
  flyTo(o){ this.fly = o; }
}
w.maplibregl = { Map: StubMap, NavigationControl: class {} };
w.fetch = (url) => Promise.resolve({
  ok: true, status: 200,
  json: async () => url.indexOf("ratings") >= 0 ? JSON.parse(JSON.stringify(FIX_RATINGS))
                                                : JSON.parse(JSON.stringify(FIX_GEO))
});

/* Test-side transform only: sloppy + var so top-level bindings attach to window.
   The production file keeps "use strict" and lexical scoping. */
const APP_TESTABLE = APP_JS.replace('"use strict";', "").replace(/\bconst\b/g, "var").replace(/\blet\b/g, "var");
w.eval(APP_TESTABLE);

setTimeout(() => {
  const $ = id => w.document.getElementById(id);
  const mapStub = w.map;
  ck("map-created", !!mapStub && mapStub instanceof StubMap);
  ck("layers-added", !!mapStub.layers["zones-fill"] && !!mapStub.layers["zones-line"] &&
                     !!mapStub.layers["zones-sel"] && !!mapStub.layers["dl-pts"]);
  eq("sources", Object.keys(mapStub.sources).sort(), ["dl", "zones"]);
  ck("home-autoselected", $("hdrZone").textContent.indexOf("ORZ693") === 0);
  eq("matrix-7-cells", $("matrix").children.length, 7);
  ck("matrix-not-ghost", !$("matrix").children[0].className.includes("ghost"));
  ck("matrix-dl-bolt", $("matrix").children[2].innerHTML.indexOf("⚡") >= 0);
  eq("ticks", $("scrubTicks").children.length, 7);
  eq("pill-model", $("pillModel").textContent, "gfs_seamless");
  ck("pill-zones", $("pillZones").textContent.indexOf("2 rated") === 0);
  ck("panel-visible", $("pnlBody").style.display === "block");

  /* v1.2 — NFDRS palette + adjective labels */
  ck("nfdrs-green-low", w.eval("TIER_COLORS[0]") === "#3f9d4f" && w.eval("TIER_COLORS[4]") === "#d93025");
  ck("matrix-adjective", $("matrix").children[0].querySelector(".tier").textContent.trim() === "HIGH"); /* t=2 */
  ck("panel-no-Tnum", !/→ T\d/.test($("pnlRating").textContent));

  /* v1.2 — basemap selector: 4 options, default persisted, apply swaps visibility + outline color */
  eq("basemap-options", $("basemapSel").children.length, 4);
  eq("basemap-default", $("basemapSel").value, "carto-dark");
  w.eval("applyBasemap('usgs-topo')");
  ck("basemap-visibility", mapStub.layout.some(l => l[0] === "bm-usgs-topo" && l[2] === "visible") &&
                           mapStub.layout.some(l => l[0] === "bm-carto-dark" && l[2] === "none"));
  ck("basemap-outline-light", mapStub.paints.some(p => p[0] === "zones-sel" && p[2].indexOf("#14181d") >= 0));
  ck("basemap-persisted", w.localStorage.getItem("fpb.map.basemap.v1") === "usgs-topo");

  /* v1.2 — dl layer present; jsdom has no 2D canvas so the circle fallback is the expected path */
  ck("dl-fallback-circle", mapStub.layers["dl-pts"].type === "circle");

  /* v1.3 — schema v2 panel: weather grid with CAPE, top-2 drivers */
  ck("wx-grid-visible", $("pnlWxWrap").style.display === "block");
  ck("wx-grid-cape", $("pnlWx").textContent.indexOf("CAPE") >= 0 && $("pnlWx").textContent.indexOf("J/kg") >= 0);
  ck("top2-rendered", $("pnlDrivers").textContent.indexOf("1. ") >= 0 && $("pnlDrivers").textContent.indexOf("2. ") >= 0);
  w.eval("setDay(4)");   /* ORZ693 day4: t=0 — inhibitor should show */
  ck("inhibitor-rendered", $("pnlDrivers").textContent.indexOf("Biggest inhibitor") >= 0);
  ck("inhibitor-names-rh", $("pnlDrivers").textContent.indexOf("higher RH") >= 0);
  w.eval("setDay(0)");
  w.eval("selectZone('WYZ275')");   /* v1-shaped zone: weather hidden, single-driver fallback */
  ck("v1-zone-wx-hidden", $("pnlWxWrap").style.display === "none");
  w.eval("setDay(4)");
  ck("v1-zone-single-driver", $("pnlDrivers").textContent.indexOf("Top driver") >= 0);
  w.eval("setDay(0)"); w.eval("selectZone('ORZ693')");

  /* v1.2 — outlooks dropdown toggles and carries the v83 link set */
  $("btnOutlooks").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ck("outlooks-open", $("outlooksMenu").classList.contains("open"));
  ck("outlooks-links", $("outlooksMenu").querySelectorAll("a").length >= 14);
  w.document.body.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ck("outlooks-closes", !$("outlooksMenu").classList.contains("open"));
  ck("panel-adj", $("pnlRating").textContent.indexOf("HIGH") >= 0);   /* t=2 -> ADJ[2] */

  /* scrub to day 2: fill expr repaints on t2, dl filter follows, panel updates */
  w.eval("setDay(2)");
  eq("scrub-synced", $("scrub").value, "2");
  const lastPaint = mapStub.paints[mapStub.paints.length - 1];
  ck("repaint-t2", lastPaint[0] === "zones-fill" && lastPaint[2].indexOf('"t2"') >= 0);
  ck("dl-filter-day2", JSON.stringify(mapStub.filters["dl-pts"]).indexOf('"dl2"') >= 0);
  ck("panel-day2-extreme", $("pnlRating").textContent.indexOf("EXTREME") >= 0);  /* t=4 */
  ck("matrix-active-follows", $("matrix").children[2].className.includes("active"));

  /* unrated zone: geo present, no rating record */
  w.eval("selectZone('XXZ999')");
  ck("unrated-panel", $("pnlRating").textContent.indexOf("No national rating") >= 0);
  ck("sel-filter", JSON.stringify(mapStub.filters["zones-sel"]).indexOf("XXZ999") >= 0);

  /* pins: ORZ693 seeded — select it, unpin, re-pin */
  w.eval("selectZone('ORZ693')");
  ck("pin-seeded", w.eval("S.pins.includes('ORZ693')"));
  $("btnPinCur").dispatchEvent(new w.Event("click"));
  ck("pin-removed", !w.eval("S.pins.includes('ORZ693')"));
  $("btnPinCur").dispatchEvent(new w.Event("click"));
  ck("pin-readded", w.eval("S.pins.includes('ORZ693')"));

  /* search + fly */
  const inp = $("zSearch"); inp.value = "wyz 275";
  inp.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter" }));
  ck("search-fly", !!mapStub.fly && Math.abs(mapStub.fly.center[0] - (-107.95)) < 0.01);
  ck("search-selects", $("hdrZone").textContent.indexOf("WYZ275") === 0);

  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}, 80);
