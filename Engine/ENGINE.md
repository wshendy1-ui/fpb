# FPB Engine v1

The compute core of Fire Potential Dashboard v83, extracted into two view-agnostic
modules. **Math is verbatim** — only the plumbing changed: functions that read v83
globals (`area()`, `state`, `fx`, `dd(i)`) now take explicit arguments. Every symbol
carries a `/* v83:LINE */` provenance comment in source.

```
engine/
  core.js       scoring, composite, aggregation math (no I/O, no DOM)
  sources.js    Open-Meteo + FEMS builders and parsers (fetch injected)
  test/engine.test.js
```

## Loading

**Browser** (order matters):
```html
<script src="engine/core.js"></script>
<script src="engine/sources.js"></script>
<script> const sev = FPBCore.devSev("tmax", 97, "2026-07-14", zoneNormals); </script>
```

**Node** (cron, tests):
```js
const C = require("./engine/core.js");
const S = require("./engine/sources.js");
```

## Verification

`node test/engine.test.js` (set `V83_PATH` if v83 isn't at the default path). Two layers:

- **Parity** — extracts the *original* function source out of the v83 HTML at test
  time (comment-aware brace balancer), evaluates it in a sandbox, and asserts the
  engine matches on fixture grids. Covers every global-free function: `ercY`,
  `kbdiStep`, `ffwiHour`, `hdwHour`, `gsiDaily`, `isoDurHours`, `sevFromThr`,
  `ercSev/Band`, `hainesTerm`, `compass16`, `pctlFromQ`, `sigTier`, `adjLevel`,
  `horizonScore`, `normDateKey`, the CSV chain (`parseFemsCsv` → `collectCsvEntries`
  → `reduceEntriesDaily`), and full `parseOmOne` on a synthetic 2-day multi-level
  response.
- **Boundaries** — exact-edge fixtures for every re-plumbed function: sigma ladder
  at −1.0/−0.5/0.75/1.5, MIN_SD flooring, the σ→departure→absolute fallback chain,
  dry-lightning gates at PoT 5/10/15/25 and the `precip<0.10 ∧ rhmin<35` dryness
  test, LAL/RFW ladders, composite bucket math, aggregation modes, FEMS stale
  quarantine + pseudo-row fill, OM URL construction, and the omFetch self-heal loop.

Current result: **167 passed, 0 failed.**

## API and provenance

### core.js — constants
All field-tunable constants, verbatim: `THR_DEF` (663), `DEV_SEV_THR` (635),
`SIGMA_SEV_THR` (639), `SIGMA_BANDS` (640), `SD_KEY`/`MIN_SD`/`ANOM_NKEY` (641–643),
`W_ERC/W_HAINES/W_LAL/W_DRY/W_RFW` (686), `DRYLTG_POT/LAB/SEV` (688), `ADJ`/`ADJ_S`
(689–690), `ROW_BUCKET` (692), `CONF_*` (695–702), `DEF_BREAKS` (662), `FM_SET/LAB/VARY`
(647–649), `IDX_MAX`/`FM_MIN` (652–653), `PSEUDO_SIDS` (646), `FMY`/`KC` (557–558),
`HAINES_VAR` (917), `HDW_LVLS`/`HAINES_PL` (1094–1095), `WX_FIELDS` (1162), `WX_DIR`
(1163), `MOD_PHRASE` (2588).

### core.js — functions

| Engine call | v83 origin | Plumbing change |
|---|---|---|
| `ercY(fm1,fm10,fm100,fm1000,kbdi)` | 559 | none |
| `kbdiStep(Q,tmaxF,rainIn,annP,carry)` | 579 | none |
| `ffwiHour(tF,rh,mph)` / `hdwHour(vpd,mph)` | 590/600 | none |
| `ramp` / `gsiDaily` / `isoDurHours` | 602–605 | none |
| `sevFromThr(v,t,asc)` | 612 | none |
| `ercSev(v,bp)` / `ercBand(v,bp)` | 617–618 | none |
| `hainesTerm` / `hainesAt(HC,i,variant)` | 921/922 | none (pure already) |
| `hainesApplicableFromElev(elevM,mode)` | 934 | elevation passed in, not read from state |
| `hainesWeight(applicable,which,w)` | 2495/2498 | the non-applicable-variant weight gate, named |
| `compass16(deg)` / `pctlFromQ(q,v)` | 2297/2298 | none |
| `normDateKey(s)` / `num(x)` / `fmBase(f)` / `bucketOf(id)` / `confBand(n)` | 1825/868/650/693/703 | none |
| `wxDep(normals,id,dateKey,value)` | 2241 | normals + date + value explicit |
| `wxSigma(normals,id,dateKey,value)` | 2251 | same |
| `sigTier(z)` | 2267 | none |
| `devSev(id,value,dateKey,normals,thr?)` | 2268 | normals/date/value/thresholds explicit; `thr` defaults `THR_DEF` |
| `devBasis(id,dateKey,normals)` | new | reports which fallback stage applies ("sigma"/"dep"/"abs") for badges + verification records |
| `dryLightning({pot,cape,precip,rhmin})` | 2450 | day fields passed as an object |
| `lalFromPot(pot)` / `lalSev(v)` | 2490–2493 | extracted from the LAL row |
| `rfwSev(v,alertsOk)` | 2525 | alerts-feed health passed in |
| `scoreContribs(entries)` | 2528 | adapter supplies `[{id,s,w,…}]`; fusion + f/w buckets verbatim |
| `adjLevel(sc)` | 2543 | none |
| `horizonScore(idxs,days,key?)` | 2544 | none |
| `horizonConf(idxs,confByDay,dayKeys)` | 2549 | conf map + day keys explicit |
| `horizonDrivers(idxs,days)` | 2556 | contrib entries carry `{id,nm?,cv}` instead of row refs |
| `horizonModerators(idxs,days)` | 2588 | same |
| `aggregateWx(samples,dayKeys,mode)` | 1170 | returns `{d,who,tzOff}`; does **not** merge into prior state (see notes) |
| `modelSpread(samples,dayKeys)` | 704 | samples + day keys explicit |

### sources.js

| Engine call | v83 origin | Plumbing change |
|---|---|---|
| `OM_HOURLY/OM_DAILY/OM_EXOTIC/OM_MODELS` | 952–959 | verbatim |
| `omBaseEff(cfg)` | 956 | `cfg={base?,key?}` replaces `state.omBase/omKey` |
| `omUrl(cfg,pts,model,drop)` | 963 | same; `cfg.hourly/daily` can override the lists |
| `omFetch(fetchFn,cfg,pts,m,drop)` | 979 | `fetch` injected; heal logic verbatim (named-var drop → exotic shed → throw; 429 throws) |
| `parseOmOne(om)` | 1096 | **verbatim** — the big one: one model response → per-day derived fields incl. layer-max HDW, FFWI, RH recovery, Haines at 16:00 local |
| `femsUrl(cfg)` | 1322 | `{url?,ids,d0,d6,fuelModels,dataset}` explicit |
| `CSV_FIELDS/CSV_META` | 1837 | verbatim |
| `normHdr/splitDelim/sniffDelim/splitCsvLine` | 1832–1862 | none |
| `parseFemsCsv(text)` | 1863 | none |
| `colDateOk(parsed,c)` | 1885 | none |
| `autoMapCsv(parsed,knownIds)` | 1889 | `area().stations` → `knownIds` string array |
| `hourFrom` / `mapHasValues` | 1932/1941 | none |
| `collectCsvEntries(parsed,map,srcId,forceSid)` | 1942 | none (per-model `erc_V` splitting intact) |
| `parseFemsJson(j,{knownIds,forceSid})` | 2056 | returns **entries** instead of storing; keeps v83's Y-only filter on the JSON path |
| `reduceEntriesDaily(entries)` | 1976 | none (worst-case daily reduction, nearest-13:00 tiebreak) |
| `aggregateFems({femsBy,stations,mode,skipStale,today})` | 1701 | state → args; returns `{agg,stale}`; `today` injected for testability |

## Behavioral notes (the honest deltas)

- **`aggregateWx` no longer merges.** v83 merged into the existing `fx.d` so
  NWS-owned fields (PoT, LAL, mix, tws, rfw) survived re-aggregation, then re-ran
  `buildAlerts`. The engine version returns a fresh `{d,who,tzOff}`; the adapter
  owns merging NWS fields over it and re-applying alerts.
- **`aggregateFems` yesterday.** v83 computed "yesterday" from local `Date.now()`;
  the engine derives it in UTC from the injected `today` string. Pass the zone's
  local date and behavior matches.
- **`parseFemsJson` returns entries** (v83's `importFemsJson` stored them and
  returned a count). Chain it into `reduceEntriesDaily` and your own store.
- **`horizonDrivers/Moderators`** read `c.id`/`c.nm`/`c.cv` off contrib entries;
  when building entries for `scoreContribs`, include `nm` and `cv` if you want
  driver/moderator strings.
- **`devSev` severity is unchanged** — normal-centered (at-normal = T2), σ ladder
  −1.0/−0.5/+0.75/+1.5, MIN_SD floors, fallback σ → raw departure → absolute.

## Deliberately NOT yet extracted (still in v83 only)

- NWS gridpoint parsing: `parseNwsSample`, `expandNws`, `uomFactor`, `buildFromNws`
- `buildAlerts` (RFW/FWW day mapping from the alerts feed)
- `kbdiSeries` projection glue (`kbdiStep` itself is in core)
- ArcGIS discovery: RAWS/FDRA/PSA layer walking, `rawsCandidates`, `resolveFwz`
- HDW climatology percentiles (`hdwPctlFor`, anchors UI)
- `wxNormalsRun` (superseded by the climo-fetcher static files)
- Fetch orchestration (`fetchAll`, caching/TTL), verification strip + forecast log,
  CSV import dialog + `storeFemsRows` persistence

Each of these either touches persistent state, the DOM, or a feed the redesign
replaces; they'll be ported (or intentionally retired) with the Vite wiring.

## Sketch: cron day rating (national precompute v1)

```js
const C=require("./core.js"), S=require("./sources.js");
const normals=JSON.parse(fs.readFileSync(`climo/${zoneId}.json`)); // climo-fetcher output
const drop=[];
const om=await S.omFetch(fetch,{key:process.env.OM_API_KEY},[pt],"gfs_seamless",drop);
const one=S.parseOmOne(om);
const wx=C.aggregateWx([{who:pt.name+" \u00b7 gfs",d:one}],one.days,"mean");
const days=one.days.map(k=>{
  const d=wx.d[k];
  const entries=[
    {id:"tmax", s:C.devSev("tmax", d.tmax, k,normals), w:C.THR_DEF.tmax.w},
    {id:"rhmin",s:C.devSev("rhmin",d.rhmin,k,normals), w:C.THR_DEF.rhmin.w},
    {id:"rhrec",s:C.devSev("rhrec",d.rhrec,k,normals), w:C.THR_DEF.rhrec.w},
    {id:"wind", s:C.sevFromThr(d.wind,C.THR_DEF.wind.t,1), w:C.THR_DEF.wind.w},
    {id:"gust", s:C.sevFromThr(d.gust,C.THR_DEF.gust.t,1), w:C.THR_DEF.gust.w},
    {id:"hdw",  s:C.sevFromThr(d.hdw, C.THR_DEF.hdw.t, 1), w:C.THR_DEF.hdw.w},
    {id:"dryltg",s:C.dryLightning(d).v, w:C.W_DRY}
  ];
  const sc=C.scoreContribs(entries);
  return {day:k, score:sc.score, tier:C.adjLevel(sc.score)};
});
```
