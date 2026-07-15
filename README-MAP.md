# FPB map (v1) — national choropleth wired to your daily ratings

`index.html` loads `ratings/latest.json` (the cron's output) and
`data/zones.geojson` (generated below), paints the national 5-tier
choropleth, and gives you the 7-day matrix + time scrubber, dry-lightning
⚡ overlay, zone search, pinned zones (seeded with ORZ693/694/695), and
ORZ693 auto-selected on load. Zones outside your fetched climatology show
as NO DATA gray until later tranches land — expected.

## Repo layout after this package

```
repo/
  index.html            <- this package
  tools/prep_map.js     <- shapefile -> zones.geojson (self-contained: tools/lib/shp.js included)
  data/zones.geojson    <- you generate this once (step 1)
  ratings/latest.json   <- already there (cron)
  climo/ engine/ cron/ data/zones_points.csv   <- unchanged
```

## Step 1 — generate the boundary file (once)

Use the SAME shapefile you fed prep_zones.js (your climo-fetcher `input\`
folder) — same zone-id logic, so ids are guaranteed to match the climo
files and ratings:

```powershell
cd C:\fpb
node tools\prep_map.js --shp C:\climo-fetcher\input\YOUR_FILE.shp --out data\zones.geojson
```

Expect a vertex-reduction report and a file in the ~8–25 MB range. Knobs:
`--tolerance 0.008` (degrees; simplification strength — independently
simplified neighbors can gap by up to this at high zoom, invisible
nationally) and `--quant 4` (coordinate decimals; shared borders snap
identically). If the NOTE about >45 MB prints, raise tolerance to 0.012.

## Step 2 — commit and push

```powershell
cd C:\fpb
git pull --no-rebase --no-edit     # the bot commits daily — always pull first
git add index.html tools data\zones.geojson
git commit -m "map v1: national choropleth"
git push
```

## Step 3 — turn on GitHub Pages

Repo → Settings → Pages → Source: **Deploy from a branch** → Branch:
**main** / **(root)** → Save. After ~1–2 minutes the site is live at:

```
https://wshendy1-ui.github.io/fpb/
```

**Private repo caveat:** Pages on the free plan requires a public repo.
Nothing sensitive lives in yours (the API key is an Actions secret, never a
file), so flipping visibility is safe: Settings → General → Danger Zone →
Change visibility → Public. If you'd rather stay private, Cloudflare Pages
(free) can serve a private GitHub repo — say the word and I'll write that
walkthrough instead.

## Local preview (optional)

`file://` can't fetch JSON, so use a tiny server from `C:\fpb`:

```powershell
python -m http.server 8000        # or: npx serve
# then open http://localhost:8000
```

## v1.2 changes

- **NFDRS-standard choropleth colors** — Low green, Moderate blue, High
  yellow, Very High orange, Extreme red (hexes tuned for 0.50 opacity).
- **Adjective labels** replace T# in the matrix, tooltip, and panel.
- **Basemap dropdown** (rail, persisted): Carto Dark / Carto Light /
  USGS Topo / USGS Imagery Topo — all keyless; selection outline flips
  dark/light to stay visible.
- **Lightning bolt icon** on the map (canvas-drawn, matches the legend;
  environments without 2D canvas fall back to the circle).
- **Tooltip contrast** fixed (light text on dark, hard-coded).
- **Outlooks ▾ dropdown** in the header with the full v83 resource list
  (Fuels & NFDRS / Weather / Intel groups, 14 links).

## v1.3 changes

- **Day weather panel** (schema v2): Max temp, RH min, RH recovery, wind,
  gusts, PoP, CAPE, precip for the active day of the selected zone.
- **Top-2 drivers** by weighted contribution, each with its value; on
  T0/T1 days a **Biggest inhibitor** line explains what's holding the
  rating down (e.g. "higher RH · 45%").
- Fully tolerant of v1 ratings files: zones without the new fields fall
  back to the single-driver row and hide the weather grid.

## Notes

- Tier labels align to the engine's ADJ ladder (LOW / MODERATE / HIGH /
  VERY HIGH / EXTREME); the skeleton's 6-tier mock scale is retired.
- The ratings pill goes amber past 26 h and red past 30 h since `generated`.
- Pages' CDN can serve a just-updated `latest.json` a few minutes stale
  after the morning commit; the page itself always requests no-store.
- The Refine button, RFW/RAWS layers, and yesterday-verification chip are
  visible but stubbed — they wire in the live deep-pull increment.
- Tests: `node tools\test\prep_map.test.js` (no deps) and
  `node test\map.test.js` (needs `npm i jsdom`).
