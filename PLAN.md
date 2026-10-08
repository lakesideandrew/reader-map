# Flock Watch — Twin Cities ALPR status map

Plan v0.3 — 2026-10-07. Built; see section 11 and README.md.
Decisions locked on 2026-10-06: public static site on GitHub Pages from day one; six
status buckets; high-confidence AI proposals auto-apply; Minnesota only.

## 1. What it is

A map of every city in a ~30 mile circle around Minneapolis, shaded by its current
relationship with Flock Safety (and other ALPR vendors). Overlaid with the physical
camera locations that volunteers have mapped in OpenStreetMap (the dataset behind
deflock.org). Kept current by two weekly jobs: one refreshes camera pins from OSM,
one has Claude read the week's news and propose status changes for a human to
accept or reject.

The front end reuses the look of an earlier internal map project.
Same shape — Leaflet + vanilla JS front end, no build step, small Node scripts for
data, JSON files on disk, Claude web-search module with a spend cap.

## 2. Coverage area

| Measure | Value |
|---|---|
| Downtown Minneapolis → Watertown MN | 28.5 mi / 45.8 km |
| Proposed radius | 30 mi (48 km), centered on downtown Minneapolis (44.9778, -93.2650) |

Rounding 28.5 up to 30 keeps Watertown comfortably inside instead of on the edge.
A city is "in" if its boundary polygon intersects the circle. That pulls in roughly
90–110 cities and townships across Hennepin, Ramsey, Dakota, Anoka, Washington,
Carver, Scott, plus slivers of Wright, Sherburne, Isanti, Chisago. Hudson WI (24.8 mi)
is inside the circle too but is not in the Minnesota boundary dataset; v1 is MN only
unless you want the Wisconsin side (see Questions).

Non-city entities that matter but have no polygon (county sheriffs, U of M PD, MSP
Airport PD, Met Council/transit) get an "agency" record and show as a badge on the
cities they cover, not as a shaded shape.

## 3. Status taxonomy (six buckets, decided)

| Key | Label | Color idea | Meaning |
|---|---|---|---|
| `active` | Active Flock contract | red | Flock contract in force, cameras operating |
| `other_vendor` | Active, non-Flock ALPR | lighter red / salmon | ALPR present from another vendor; treated as active, shaded a step lighter (Minneapolis: Insight LPR; Eden Prairie: Motorola; Brooklyn Park: Axon) |
| `pending` | Pending / suspended | yellow | Cancellation voted or contract suspended but not ended, or cams offline pending audit (Dayton, Shorewood, Champlin) |
| `cancelled` | Cancelled / removed | green | Contract ended or cameras removed / non-functional (Plymouth, Crystal, Columbia Heights, West St. Paul) |
| `none` | No ALPR | blue-grey | City has stated it has no ALPR cameras |
| `unknown` | Not yet researched | light grey | Default for every city until seeded |

"Kept cameras but restricted outside-agency / immigration sharing" (Fridley, St.
Louis Park, Shakopee, Woodbury) is not a color. It is a boolean flag
`sharing_restricted` on the record, shown as a small badge on the map label and in
the detail panel, and filterable in the sidebar.

## 4. Data sources (all verified reachable on 2026-10-06)

**City boundaries** — Metropolitan Council "Counties and CTUs" (public domain, Minn. Stat. Ch. 13).
`https://arcgis.metc.state.mn.us/data1/rest/services/boundary/Counties_CTUs/FeatureServer/1/query?where=1=1&outFields=CTU_NAME,CTU_CODE,CTU_ID,CO_NAME&f=geojson`
Fetched once by a seed script, filtered to the radius, simplified, saved to
`data/boundaries.geojson`. Fallback: Census TIGER places for Wisconsin if needed.

**Camera locations** — OpenStreetMap via Overpass. deflock.org has no API; its data
*is* OSM. Tested query returns ~1,345 ALPR nodes within 50 km (1,105 tagged Flock
Safety), ~0.5 MB, in seconds:
```
[out:json][timeout:60];
(
  node["man_made"="surveillance"]["surveillance:type"="ALPR"](around:48000,44.9778,-93.2650);
  way["man_made"="surveillance"]["surveillance:type"="ALPR"](around:48000,44.9778,-93.2650);
);
out body center;
```
Tags of interest: `manufacturer` (Flock Safety / Motorola / Genetec…), `operator`
(agency), `direction`, `camera:mount`, `check_date`. Weekly refresh is far inside
Overpass fair-use. Attribution required: "© OpenStreetMap contributors, ODbL".
Each camera is assigned to a city by point-in-polygon, which gives a per-city
"cameras mapped in OSM" count to cross-check against the status (e.g. a city marked
`cancelled` that still has 10 mapped cameras gets a "possibly stale" flag).

**Contract status seed** — hand-curated from the research already done (see §9),
cross-checked against the mnprivacy.org tracker (built from BCA-mandated reports)
and the EFF Atlas of Surveillance CSV (`https://atlasofsurveillance.org/download.csv`,
CC-BY, filter State=MN + "License Plate"). Flock transparency portals
(`transparency.flocksafety.com/<agency-slug>`) are a per-agency confirmation source.

**News** — Claude's hosted `web_search` tool, with server-side search results.

## 5. Data model (JSON on disk, no database)

```
data/
  boundaries.geojson      # Met Council CTU polygons, radius-filtered (seeded once)
  cities.json             # one record per city — THE curated truth
  agencies.json           # sheriffs, U of M PD, airport, etc.
  cameras.geojson         # Overpass output, refreshed weekly
  cameras-by-city.json    # derived: counts + manufacturer breakdown per CTU_ID
  history.jsonl           # append-only log of every status change (who/when/why/source)
  proposals.json          # AI-suggested changes awaiting review
  ai-runs/                # one JSON per weekly run: prompt, searches, cost, raw output
```

`cities.json` record:
```json
{
  "ctu_id": "2394683", "name": "Plymouth", "county": "Hennepin",
  "status": "cancelled", "vendor": "Flock Safety", "sharing_restricted": false,
  "camera_count_reported": 16,
  "contract_start": null, "contract_end": "2026-09-22",
  "status_since": "2026-09-22", "summary": "Council voted to discontinue all 16 cameras; mayor sole dissent.",
  "sources": [{"url": "https://www.mprnews.org/...", "title": "...", "date": "2026-09-23"}],
  "agencies": ["hennepin-co-sheriff"],
  "confidence": "high", "last_reviewed": "2026-10-06", "last_ai_check": null,
  "notes": ""
}
```

## 6. Front end

Single page, Leaflet 1.9, vanilla JS, Papa-free (JSON only). Reuse the earlier project's CSS tokens
(`--cc-*`), topbar, sidebar, detail panel and dark / light-paper themes.

- **Map**: CTU polygons as a choropleth by status; thin boundary lines; hover
  highlights, click opens detail. Radius circle drawn faintly. Camera pins as small
  dots colored by manufacturer (Flock vs other), clustered below zoom 11, toggleable.
- **Sidebar**: status filter chips with live counts, county filter, text search,
  list of cities sorted by most-recent change.
- **Detail panel**: status badge, vendor, reported camera count vs OSM-mapped count,
  contract dates, summary, source links, change timeline from `history.jsonl`,
  covering agencies, "last AI check" date, and (if private mode) an edit form.
- **Header stats**: cities per status, cameras mapped, last OSM refresh, last AI run.
- **Changes tab** (public, read-only): a feed from `history.jsonl` — every status
  change with date, source link, and whether it was applied by a human or by the
  weekly AI run. Below it, "Awaiting review": lower-confidence proposals the AI
  found but did not apply, so visitors can see what is being looked at.
- **Legend** with the six statuses, the restricted-sharing badge, and the OSM
  attribution.

Accepting or rejecting a lower-confidence proposal happens off the public site,
via `npm run review`: a small terminal walkthrough that shows each proposal, takes
accept / reject / edit, updates `cities.json` + `history.jsonl`, and commits. A
later nicety is a GitHub-login edit UI, but v1 keeps writes out of the browser.
- Phone width works (sidebar becomes a drawer).

## 7. Weekly jobs

**`scripts/refresh-cameras.js`** (weekly)
Overpass query → normalize → point-in-polygon assign to CTU → write
`cameras.geojson` + `cameras-by-city.json`. Diff against previous run and log
added/removed cameras per city into `history.jsonl` as `osm_change` events.

**`scripts/ai-news-check.js`** (weekly, after the camera refresh)
1. Broad sweep: one Claude call with web_search (≤6 searches): "Minnesota Flock /
   ALPR news in the last 8 days" → list of (city, headline, url, date).
2. Targeted checks: for every city whose status is `pending` or `unknown`, and any
   city named in the sweep, one call per batch of ~8 cities (≤4 searches each),
   given each city's current status and `last_reviewed`, asking only for changes
   since that date. Structured JSON output: `{ctu_id, proposed_status, effective_date,
   evidence_excerpt, url, confidence}`.
3. Dedup each proposal against existing proposals and the city's current status.
4. **Auto-apply** when all of these hold: `confidence: high`, the proposed status
   differs from current, the source URL's host is on the trusted-outlet list
   (startribune.com, mprnews.org, kstp.com, cbsnews.com/minnesota, kare11.com,
   fox9.com, sahanjournal.com, minnesotareformer.com, hometownsource.com, axios.com,
   any `.mn.us` / city `.gov` / `.org` municipal domain), and the effective date is
   within the last 60 days. Applied changes update `cities.json`, append to
   `history.jsonl` with `applied_by: "ai"`, and the previous status is kept in the
   log so a bad apply is a one-line revert.
5. Everything else goes to `proposals.json` for `npm run review`.
6. Update `last_ai_check` on every city examined; save the full run to `ai-runs/`.

Cost: roughly 10–15 searches for the sweep + batches, ~$0.15 in searches plus
tokens; expect well under $2 per week. Hard cap via `MAX_WEEKLY_SPEND_USD` like
a per-run spend cap. Model is set via env (default: current Sonnet-class model).

**Scheduling and hosting (decided: public static site)**
- Repo on GitHub; `web/` is served by GitHub Pages (or Cloudflare Pages, same idea).
- `.github/workflows/weekly.yml`: cron Monday 06:00 CT. Steps: checkout, `npm ci`,
  `npm run refresh:cameras`, `npm run ai:check`, commit any changed `data/*` files,
  push. `ANTHROPIC_API_KEY` lives in repo secrets. Also runnable on demand with
  `workflow_dispatch`.
- The site fetches `data/*.json` relative to itself, so a push is a deploy.
- Local dev is `npm run serve` (python http.server or `npx serve web`), no backend.

## 8. Phases

| # | Deliverable | Rough effort |
|---|---|---|
| 0 | Repo scaffold, `git init`, `.env.example`, boundaries seed script, radius filter, map with all cities grey | half day |
| 1 | `cities.json` seeded from research (§9), choropleth, sidebar, detail panel, legend, stats | 1 day |
| 2 | Overpass refresh script, camera layer, per-city counts, stale-status flag | half day |
| 3 | AI news check script with spend cap, auto-apply rules, `proposals.json`, `npm run review`, Changes tab | 1 day |
| 4 | GitHub repo + Pages + Actions cron, README, first real weekly run checked by hand | half day |

## 9. Seed status snapshot (research as of 2026-10-06)

Cancelled / removed: Brooklyn Park (Dec 2025, moved to Axon, so `other_vendor`),
Columbia Heights (Jun 2026), West St. Paul (suspended Aug 2026, cams removed),
St. Paul (Aug 2026, PD's 2 cams removed; Ramsey Co. Sheriff's 37 remain),
Crystal (Sep 2026), Plymouth (Sep 2026).
Pending / suspended: Champlin (offline after vandalism), Dayton (suspended through
2027), Shorewood (1 cam off pending audit), U of M PD (1 removed, ~13 remain).
Active with `sharing_restricted: true`: Fridley, St. Louis Park, Shakopee,
Woodbury, Richfield, Edina.
Active (BCA counts): Blaine 32, Coon Rapids 18, Stillwater 18, Lakeville ~18,
Minnetonka 13, Eagan 13, Cottage Grove 12, Brooklyn Center 11, Mounds View 10,
Wayzata 10, Hopkins 8, New Brighton 8, Rogers 8, New Hope 9, Prior Lake 9,
South St. Paul 9, Corcoran 9, Anoka 7, Roseville 6, Medina 6, Deephaven 5,
Osseo 4, Minnetrista 4, Oakdale 3, Robbinsdale 2, Orono 2, Spring Lake Park 2,
Forest Lake 2, Maple Grove 1, Golden Valley, White Bear Lake, Farmington,
Rosemount, North St. Paul, Burnsville, Maplewood (installed, not activated?).
Other vendor: Minneapolis (Insight LPR, ~30), Eden Prairie (Motorola).
Agencies: Hennepin, Ramsey, Anoka, Dakota county sheriffs; MSP Airport; West
Hennepin Public Safety.
Unknown: Bloomington, Apple Valley, Inver Grove Heights, Mendota Heights, Savage,
Chaska, Chanhassen, Waconia, Watertown, Delano, Mound, Shoreview, and every
township.

Context the AI prompt should carry: Minn. Stat. 13.824 (60-day retention, sharing
only for active criminal investigations), the July 2026 Star Tribune audit on
immigration searches during "Operation Metro Surge", HF 4205 / SF 4739 stalled in
March 2026 and expected back in 2027, ACLU-MN "Get the Flock Out", DeFlock MPLS,
mnprivacy.org tracker.

## 10. Decisions log

| Date | Decision |
|---|---|
| 2026-10-06 | Public static site (GitHub Pages + Actions cron) from the start |
| 2026-10-06 | Six statuses: active, other_vendor (lighter active shade), pending, cancelled, none, unknown; restricted sharing is a badge |
| 2026-10-06 | AI proposals auto-apply when high confidence + trusted outlet + recent; others queue for `npm run review` |
| 2026-10-06 | Minnesota only; 30 mi circle around downtown Minneapolis |

## 11. Build notes (2026-10-07)

Phases 0 to 3 are built, and phase 4 is ready to push. See README.md for how to run everything.

| Item | Decision |
|---|---|
| Repo name | `reader-map` |
| Townships | Kept as their own shapes. They inherit their county sheriff's status, drawn lighter with a dashed outline. The news check skips them. |
| County sheriffs | Modeled as agencies. Contract cities (Ramsey and Anoka sheriff contracts, West Hennepin Public Safety) and all townships inherit them. Every city's panel shows its county sheriff. |
| Boundaries | MnDOT statewide CTU layer instead of Met Council, because the circle reaches Wright, Sherburne, Chisago and Rice counties. 183 shapes. |
| Basemap | Esri World Gray Canvas. CARTO now requires an API key. |
| AI model | `claude-opus-5-5`, with the server-side refusal fallback. Override with `ANTHROPIC_MODEL`. |
| AI scope per run | Metro sweep, all pending and low-confidence places, plus 2 rotating batches of 8 unknowns. Capped at $3 a run. |
| Auto-apply guard added | The source URL must have appeared in that run's search results. Unverified links are never shown publicly. |
| Data location | `web/data/` so Pages serves it directly. |

Not yet done: the first live AI run, because no API key was available while building. The GitHub repo is also not created or pushed yet.
