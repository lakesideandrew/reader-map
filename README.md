# Reader Map

A public map of which Twin Cities metro cities use Flock Safety and other automated license plate reader (ALPR) cameras, which have paused or cancelled them, and where the cameras are.

- Every city and township within 30 miles of downtown Minneapolis, shaded by status.
- About 1,300 camera locations from OpenStreetMap, the dataset DeFlock maps into.
- Refreshed weekly: an OpenStreetMap camera pull, then a Claude news check that applies only conclusive, recent, well-sourced changes and queues the rest for review.

It is a static site. No server, no database. The data lives in `web/data/*.json` and a GitHub Actions cron keeps it current.

## Statuses

| Key | Map color | Meaning |
|---|---|---|
| `active` | red | Flock contract in force, cameras operating |
| `other_vendor` | light red | ALPRs from another vendor (Motorola, Axon, Insight LPR) |
| `pending` | yellow | Cancellation voted but not done, contract suspended, or cameras off pending review |
| `cancelled` | green | Contract ended, or cameras removed or non-functional |
| `none` | blue | City says it uses no ALPRs |
| `unknown` | grey | Not yet confirmed |

"Data sharing restricted" is a flag on the record, not a color.

Townships and cities without their own police department inherit the status of the agency that polices them, usually the county sheriff. The map draws those lighter with a dashed outline.

## Layout

```
web/                    the site (deployed as-is)
  index.html  app.js  styles.css  config.js
  data/
    boundaries.geojson  city and township polygons (MnDOT), seeded once
    boundaries-land.geojson  same shapes with lakes and rivers cut out, used for display
    cities.json         one record per city or township: the curated truth
    agencies.json       county sheriffs, U of M police, airport police, etc.
    cameras.geojson     OpenStreetMap ALPR cameras, refreshed weekly
    cameras-by-city.json
    history.json        every change, with source and who made it
    proposals.json      AI findings waiting for an editor
    meta.json           last refresh times
scripts/
  seed-boundaries.js    MnDOT CTU layer -> boundaries.geojson
  seed-cities.js        boundaries + data/seed/*.json -> cities.json, agencies.json
  seed-water.js         cuts DNR lakes (30+ acres) and river channels out of the shapes
  refresh-cameras.js    Overpass -> cameras.geojson (weekly)
  ai-news-check.js      Claude web search -> auto-apply or queue (weekly)
  review.js             editor tools: walk the queue, or set a status by hand
  lib/apply.js          the auto-apply rules (unit tested)
data/seed/              hand-curated starting statuses with sources
.github/workflows/      weekly.yml (cron) and pages.yml (deploy)
```

## Run it locally

Needs Node 20 or later.

```bash
npm install
npm run serve
```

Then open http://localhost:8080.

## Weekly jobs

```bash
npm run refresh:cameras                 # OpenStreetMap camera pull, about 10 seconds
npm run ai:check                        # needs ANTHROPIC_API_KEY in .env
npm run ai:check -- --dry-run           # research and decide, change nothing
```

The news check does three things each week:

1. A metro-wide sweep for ALPR news since the last run.
2. A re-check of every place marked pending or low confidence.
3. Two batches of eight "unknown" cities or sheriffs, oldest-checked first, so every unknown gets researched over about six weeks.

Each research call uses Claude with web search. A second call turns the report into structured findings. `scripts/lib/apply.js` then decides what happens to each one.

A finding is **applied automatically** only when all of these hold:

- Confidence is high, and the source reports a completed action rather than a proposal or a scheduled vote.
- The source is a recognized Twin Cities outlet or a `.gov` or `.mn.us` site.
- The action is dated within the last 60 days.
- The link appeared in the actual search results.
- It is the only change for that place in this run.

Everything else goes to `proposals.json`. A proposal whose link never appeared in search results stays in the editor queue but is never shown on the public site. Every applied change is logged in `history.json` with its previous status, so a bad change can be reverted.

Spend is capped per run by `MAX_RUN_SPEND_USD`, default $3. Expect roughly $1 to $2 a week on Claude Opus 5.5. Requests use the API's server-side refusal fallback, so a safety decline is retried on a fallback model instead of failing the batch.

## Editing statuses

```bash
npm run review
```

This walks through queued proposals: accept, reject or skip each one.

To set a status by hand:

```bash
npm run review -- --set "Bloomington" none "https://www.bloomingtonmn.gov/..." "Police say the city uses no plate readers." 2026-10-01
```

Commit and push afterwards. The push redeploys the site.

You can also edit `web/data/cities.json` directly. Add a `history.json` entry with `"by": "manual"` so the change shows on the Changes page.

## Deploying (GitHub Pages)

1. Create the GitHub repo and push.
2. In the repo settings, open **Pages** and set **Source** to **GitHub Actions**.
3. In **Secrets and variables → Actions**, add the secret `ANTHROPIC_API_KEY`. Optional variables are `ANTHROPIC_MODEL`, `MAX_RUN_SPEND_USD` and `ROTATION_BATCHES`.
4. Run **Weekly update** once from the Actions tab, with "dry run" checked, to confirm the key works.

After that the cron runs every Monday morning. Each run's full research log is kept as a workflow artifact for 90 days.

## Re-seeding

```bash
npm run seed:boundaries   # re-pull polygons, e.g. after an annexation
npm run seed:water        # then re-cut lakes and rivers out of them
npm run seed:cities       # adds new places only; never overwrites existing records
```

`npm run seed:cities -- --force` rebuilds every record from `data/seed/`. It discards AI and manual edits, so avoid it once the site is live.

## Data sources and licenses

- Cameras: © OpenStreetMap contributors, ODbL. Attribution is required and shown on the map. Tag scheme: `man_made=surveillance` + `surveillance:type=ALPR`.
- Boundaries: MnDOT, City, Township and Unorganized Territory in Minnesota (gis.data.mn.gov).
- Lakes and rivers: MN DNR Hydrography Dataset (gis.data.mn.gov). Camera counts use the uncut boundaries, so cameras on bridges and causeways still count for their city.
- Reported camera counts: mnprivacy.org tracker, built from state-required agency reports, plus the news sources linked on each record.
- Basemap: Esri World Gray Canvas. To swap it, edit `tileUrls()` in `web/app.js`.
