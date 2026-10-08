// Weekly AI news check.
//
//   1. Research: Claude with web search looks for ALPR / Flock news about
//      (a) the whole metro since the last run, and (b) a rotating set of
//      places whose status is unknown, pending, or low confidence.
//   2. Extract: a second, tool-free call turns each research report into
//      structured findings.
//   3. Decide: scripts/lib/apply.js applies conclusive, recent findings
//      from trusted outlets and queues the rest in proposals.json.
//
// Usage:
//   npm run ai:check                 normal weekly run
//   npm run ai:check -- --dry-run    research + decide, write nothing but the run log
//   npm run ai:check -- --fixture f  skip the API; read findings from a JSON file
//
// Env: ANTHROPIC_API_KEY, ANTHROPIC_MODEL (default claude-opus-5-5),
//      MAX_RUN_SPEND_USD (default 3), ROTATION_BATCHES (default 2).
import fs from "node:fs";
import path from "node:path";
import { FILES, RUNS_DIR, ROOT, log, readJson, writeJson, today, isMain } from "./lib/common.js";
import { decide, applyFinding } from "./lib/apply.js";

loadDotEnv();

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const MAX_SPEND = Number(process.env.MAX_RUN_SPEND_USD || 3);
const ROTATION_BATCHES = Number(process.env.ROTATION_BATCHES || 2);
const BATCH_SIZE = 8;
const EST_COST_PER_CALL = 0.6; // conservative guess used to stop before the cap

// $ per million tokens; web search is $10 per 1,000 searches.
const PRICES = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.2 },
  "claude-fable-5-1": { in: 10, out: 50, cacheRead: 0.25 },
};
const SEARCH_PRICE = 0.01;

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const fixtureIdx = args.indexOf("--fixture");
const FIXTURE = fixtureIdx >= 0 ? args[fixtureIdx + 1] : null;

function loadDotEnv() {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// ---------- spend tracking ----------
const spend = { usd: 0, searches: 0, inTok: 0, outTok: 0, calls: 0 };
function addUsage(usage) {
  const p = PRICES[MODEL] || PRICES["claude-opus-5-5"];
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const searches = usage.server_tool_use?.web_search_requests || 0;
  spend.inTok += usage.input_tokens || 0;
  spend.outTok += usage.output_tokens || 0;
  spend.searches += searches;
  spend.calls++;
  spend.usd += (inTok * p.in + cacheRead * p.cacheRead + (usage.output_tokens || 0) * p.out) / 1e6 + searches * SEARCH_PRICE;
}
const canAfford = () => spend.usd + EST_COST_PER_CALL <= MAX_SPEND;

// ---------- target selection ----------
const STATUS_WORDS = {
  active: "active Flock contract",
  other_vendor: "active ALPR from a non-Flock vendor",
  pending: "cancellation pending or suspended",
  cancelled: "cancelled or cameras removed",
  none: "no ALPR cameras",
  unknown: "unknown",
};

function describe(rec) {
  const bits = [`${rec.name}: ${STATUS_WORDS[rec.status]}`];
  if (rec.vendor) bits.push(`vendor ${rec.vendor}`);
  if (rec.since) bits.push(`since ${rec.since}`);
  return bits.join(", ");
}

export function pickTargets(cities, agencies) {
  const all = [
    ...Object.values(cities).filter((c) => c.kind === "city"),
    ...Object.values(agencies),
  ];
  // Always re-check unsettled places.
  const watch = all.filter((r) => r.status === "pending" || r.confidence === "low");
  // Rotate through unknowns: never-checked first, then oldest check,
  // larger populations first within a tie.
  const unknown = all
    .filter((r) => r.status === "unknown")
    .sort(
      (a, b) =>
        (a.last_ai_check || "").localeCompare(b.last_ai_check || "") || (b.population || 0) - (a.population || 0),
    );
  const batches = [];
  for (let i = 0; i < watch.length; i += BATCH_SIZE) batches.push({ kind: "watch", places: watch.slice(i, i + BATCH_SIZE) });
  for (let b = 0; b < ROTATION_BATCHES; b++) {
    const slice = unknown.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    if (slice.length) batches.push({ kind: "unknown", places: slice });
  }
  return batches;
}

// ---------- prompts ----------
const SYSTEM = `You research the status of automated license plate reader (ALPR) programs, especially Flock Safety cameras, run by cities and law enforcement agencies in the Minneapolis–St. Paul metro area of Minnesota. Your research feeds a public map, so accuracy matters more than coverage.

Use web search. Prefer primary and local sources: city council minutes and agendas, city and county websites, and Twin Cities news outlets (Star Tribune, MPR News, KSTP, KARE 11, WCCO, FOX 9, Sahan Journal, Minnesota Reformer, Pioneer Press, Sun newspapers, Axios Twin Cities). The mnprivacy.org tracker summarizes state-required agency reports and is useful for whether an agency runs ALPRs at all.

Background: Minnesota Statute 13.824 limits ALPR data retention and sharing. In 2026 many metro cities reconsidered Flock after reporting showed out-of-state and federal immigration searches of local data. Some cities cancelled, some suspended, some kept cameras but restricted sharing, and county sheriffs often run cameras inside cities that cancelled their own.

Report only what sources actually say. Distinguish clearly between a completed action (a council vote passed, a contract signed or terminated, cameras removed or switched off) and discussion, petitions, proposals, or scheduled votes. Give the date of the action, not the article, when they differ. For every claim, give the exact URL of the page that supports it.`;

function sweepPrompt(since, places) {
  return `Search for news published between ${since} and ${today()} about any city, county sheriff, or police agency in the Twin Cities metro (Hennepin, Ramsey, Dakota, Anoka, Washington, Carver, Scott, and nearby Wright, Sherburne, Chisago counties) that changed, voted on, suspended, cancelled, renewed, signed, or expanded an ALPR or Flock Safety contract, or removed or switched off cameras.

For context, these are the places the map currently tracks with a known status:
${places.map((p) => `- ${describe(p)}`).join("\n")}

Write a short research report. For each development you find, give: the place, what happened, the date it happened, whether it is a completed action or only discussion, and the source URL and outlet. If you find nothing new, say so plainly.`;
}

function batchPrompt(batch) {
  const lead =
    batch.kind === "watch"
      ? "These places have an unsettled status. Find out whether anything has changed and what their current status is."
      : "The map does not yet know whether these places use ALPR cameras. For each, find whether the police department (or, for a sheriff, the sheriff's office) currently uses Flock Safety or another ALPR vendor, has cancelled, or has publicly said it uses none. If a city has no police department of its own and contracts with a county sheriff or neighboring city, say which agency.";
  return `${lead}

${batch.places.map((p) => `- ${describe(p)}`).join("\n")}

Search for each place. Write a short research report with one entry per place: current status, vendor, number of cameras if reported, whether outside-agency data sharing is restricted, the date of the most recent action, and the source URL and outlet. If you could not find reliable information for a place, say so for that place.`;
}

const EXTRACT_SYSTEM = `You convert a research report about license plate reader programs into structured findings. Use only facts stated in the report. Never invent URLs: every url must be copied exactly from the report or from the list of search result URLs provided.

Status values:
- active: the place has a Flock Safety contract in force and cameras operating
- other_vendor: the place operates ALPRs from a vendor other than Flock
- pending: a cancellation has been voted or announced but is not complete, or the contract is suspended, or cameras are switched off pending review
- cancelled: the contract has ended, or the cameras were removed or are non-functional
- none: the place has publicly stated it uses no ALPR cameras
- unknown: the report does not establish any of the above

Set conclusive to true only when the source reports a completed action or a direct official statement of current status, not a proposal, petition, discussion, or upcoming vote. Use confidence "high" only when the source is explicit and specific about this exact place; "medium" when it is likely but indirect; "low" otherwise. Use place names exactly as they appear in the list of tracked places. Include a finding only if it tells us the place's status; skip places the report found nothing about.`;

// ---------- API calls ----------
let _client;
async function client() {
  if (!_client) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    _client = new Anthropic();
  }
  return _client;
}

// One research conversation with web search. Resumes on pause_turn.
async function research(prompt) {
  const c = await client();
  const messages = [{ role: "user", content: prompt }];
  const urls = new Map();
  let text = "";
  for (let turn = 0; turn < 4; turn++) {
    const stream = c.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { effort: "medium" },
      tools: [
        {
          type: "web_search_20260209",
          name: "web_search",
          max_uses: 8,
          user_location: { type: "approximate", city: "Minneapolis", region: "Minnesota", country: "US", timezone: "America/Chicago" },
        },
      ],
      messages,
    });
    const msg = await stream.finalMessage();
    addUsage(msg.usage);
    if (msg.stop_reason === "refusal") {
      log(`  research refused (${msg.stop_details?.category ?? "no category"}); skipping this batch`);
      return { text: "", urls: [] };
    }
    for (const b of msg.content) {
      if (b.type === "text") {
        text += b.text;
        for (const cit of b.citations || []) if (cit.url) urls.set(cit.url, cit.title || "");
      } else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const r of b.content) if (r.url) urls.set(r.url, r.title || "");
      }
    }
    if (msg.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: msg.content });
  }
  return { text, urls: [...urls].map(([url, title]) => ({ url, title })) };
}

async function extract(report, urls, trackedNames) {
  const c = await client();
  const { z } = await import("zod");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const Finding = z.object({
    place: z.string(),
    proposed_status: z.enum(["active", "other_vendor", "pending", "cancelled", "none", "unknown"]),
    vendor: z.string().nullable(),
    cameras: z.number().int().nullable(),
    sharing_restricted: z.boolean().nullable(),
    effective_date: z.string().nullable().describe("YYYY-MM-DD date of the action, or null if not stated"),
    summary: z.string().describe("One or two plain sentences for the public map, no hedging words"),
    evidence: z.string().describe("Short paraphrase of what the source says"),
    url: z.string(),
    title: z.string(),
    outlet: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
    conclusive: z.boolean(),
  });
  const Schema = z.object({ findings: z.array(Finding) });

  const resp = await c.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: EXTRACT_SYSTEM,
    output_config: { effort: "low", format: zodOutputFormat(Schema) },
    messages: [
      {
        role: "user",
        content: `Today is ${today()}.

Tracked places (use these exact names):
${trackedNames.join(", ")}

Search result URLs seen during research:
${urls.map((u) => `- ${u.url}${u.title ? ` (${u.title})` : ""}`).join("\n") || "(none)"}

Research report:
${report}`,
      },
    ],
  });
  addUsage(resp.usage);
  if (resp.stop_reason === "refusal" || !resp.parsed_output) return [];
  return resp.parsed_output.findings;
}

// ---------- main ----------
async function main() {
  const cities = readJson(FILES.cities);
  const agencies = readJson(FILES.agencies);
  const history = readJson(FILES.history, []);
  const proposals = readJson(FILES.proposals, []);
  const meta = readJson(FILES.meta, {});
  const runDate = today();

  const examined = new Set();
  const reports = [];
  let findings = [];
  const knownUrls = new Set();
  const failures = [];

  if (FIXTURE) {
    const fx = readJson(path.resolve(FIXTURE));
    findings = fx.findings;
    for (const u of fx.knownUrls || findings.map((f) => f.url)) knownUrls.add(u);
    log(`fixture: ${findings.length} findings`);
  } else {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      // In GitHub Actions, warn and skip so the camera refresh still ships.
      if (process.env.GITHUB_ACTIONS) {
        console.log("::warning::ANTHROPIC_API_KEY secret is not set; skipping the AI news check this week.");
        return;
      }
      console.error("ANTHROPIC_API_KEY is not set. Add it to .env or the environment.");
      process.exit(2);
    }
    const trackedNames = [
      ...Object.values(cities).filter((c) => c.kind === "city").map((c) => c.name),
      ...Object.values(agencies).map((a) => a.name),
    ];
    const known = [...Object.values(cities).filter((c) => c.kind === "city"), ...Object.values(agencies)].filter(
      (r) => r.status !== "unknown",
    );
    const lastRun = meta.aiCheckedAt ? meta.aiCheckedAt.slice(0, 10) : null;
    const eightDaysAgo = new Date(Date.now() - 8 * 864e5).toISOString().slice(0, 10);
    const since = lastRun && lastRun < eightDaysAgo ? lastRun : eightDaysAgo;

    const jobs = [{ label: `metro sweep since ${since}`, prompt: sweepPrompt(since, known), places: [] }];
    for (const b of pickTargets(cities, agencies))
      jobs.push({ label: `${b.kind}: ${b.places.map((p) => p.name).join(", ")}`, prompt: batchPrompt(b), places: b.places });

    for (const job of jobs) {
      if (!canAfford()) {
        log(`budget: stopping before "${job.label}" ($${spend.usd.toFixed(2)} of $${MAX_SPEND} spent)`);
        break;
      }
      log(`research: ${job.label}`);
      try {
        const r = await research(job.prompt);
        for (const u of r.urls) knownUrls.add(u.url);
        for (const p of job.places) examined.add(p.id);
        if (!r.text.trim()) continue;
        const f = await extract(r.text, r.urls, trackedNames);
        log(`  ${r.urls.length} sources, ${f.length} findings, running total $${spend.usd.toFixed(2)}`);
        reports.push({ label: job.label, report: r.text, urls: r.urls, findings: f });
        findings.push(...f);
      } catch (e) {
        // One failed batch should not lose the rest of the run.
        failures.push({ label: job.label, error: String(e?.message || e) });
        log(`  FAILED: ${e?.message || e}`);
        if (e?.status === 401 || e?.status === 403) break;
      }
    }
  }

  const decisions = decide(findings, { cities, agencies, today: runDate, knownUrls });

  let applied = 0;
  let proposed = 0;
  for (const d of decisions) {
    const f = d.finding;
    if (d.action === "apply") {
      const rec = d.target.kind === "city" ? cities[d.target.id] : agencies[d.target.id];
      history.push(applyFinding(rec, d.target, f, runDate));
      examined.add(d.target.id);
      applied++;
      log(`APPLY  ${rec.name}: ${f.proposed_status} (${f.url})`);
    } else if (d.action === "propose") {
      const dup = proposals.find(
        (p) => p.state === "open" && p[d.target.kind] === d.target.id && p.proposed_status === f.proposed_status && p.url === f.url,
      );
      if (dup) continue;
      proposals.push({
        id: `${runDate}-${proposals.length + 1}`,
        found: runDate,
        state: "open",
        [d.target.kind]: d.target.id,
        place: f.place,
        proposed_status: f.proposed_status,
        vendor: f.vendor,
        cameras: f.cameras,
        sharing_restricted: f.sharing_restricted,
        effective_date: f.effective_date,
        summary: f.summary,
        evidence: f.evidence,
        url: f.url,
        title: f.title,
        outlet: f.outlet,
        confidence: f.confidence,
        conclusive: f.conclusive,
        why_not_applied: d.reason,
        // Unverified links stay in the editor queue but are not shown publicly.
        public: knownUrls.has(f.url),
      });
      proposed++;
      log(`QUEUE  ${f.place}: ${f.proposed_status} (${d.reason})`);
    } else {
      log(`skip   ${f.place}: ${d.reason}`);
    }
  }

  for (const id of examined) {
    if (cities[id]) cities[id].last_ai_check = runDate;
    if (agencies[id]) agencies[id].last_ai_check = runDate;
  }

  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const runFile = path.join(RUNS_DIR, `${runDate}${DRY ? "-dry" : ""}${FIXTURE ? "-fixture" : ""}.json`);
  writeJson(runFile, { date: runDate, model: MODEL, dryRun: DRY, spend, failures, reports, decisions });

  if (!DRY) {
    writeJson(FILES.cities, cities);
    writeJson(FILES.agencies, agencies);
    writeJson(FILES.history, history);
    writeJson(FILES.proposals, proposals);
    if (!FIXTURE) {
      meta.aiCheckedAt = new Date().toISOString();
      meta.lastAiRun = { date: runDate, applied, proposed, spendUsd: Math.round(spend.usd * 100) / 100, searches: spend.searches };
    }
    writeJson(FILES.meta, meta);
  }
  log(
    `done: ${applied} applied, ${proposed} queued for review, ${examined.size} places examined, ` +
      `${spend.searches} searches, ~$${spend.usd.toFixed(2)}${DRY ? " (dry run, data unchanged)" : ""}`,
  );
  log(`run log: ${path.relative(ROOT, runFile)}`);
  // Fail the job (so GitHub emails you) when every research call failed.
  if (!FIXTURE && failures.length && !reports.length) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
