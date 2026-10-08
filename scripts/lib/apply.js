// Pure decision logic for AI findings: which are applied automatically,
// which wait for an editor, which are ignored. No I/O here, so it is
// unit-tested in scripts/test/apply.test.js.
import { STATUSES, normName } from "./common.js";

export const AUTO_APPLY_MAX_AGE_DAYS = 60;

// News outlets trusted for automatic changes. Government sites (.gov,
// .mn.us) are trusted too. Anything else waits for an editor.
const TRUSTED_HOSTS = [
  "startribune.com",
  "mprnews.org",
  "kstp.com",
  "kare11.com",
  "fox9.com",
  "sahanjournal.com",
  "minnesotareformer.com",
  "hometownsource.com",
  "twincities.com",
  "swnewsmedia.com",
  "presspubs.com",
  "eplocalnews.org",
  "mndaily.com",
];
// Hosts that are trusted only under a path (national sites with local desks).
const TRUSTED_PATHS = [
  ["cbsnews.com", "/minnesota/"],
  ["axios.com", "/local/twin-cities/"],
];

export function isTrustedSource(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const matches = (h) => host === h || host.endsWith("." + h);
  if (host.endsWith(".gov") || host.endsWith(".mn.us")) return true;
  if (TRUSTED_HOSTS.some(matches)) return true;
  return TRUSTED_PATHS.some(([h, p]) => matches(h) && u.pathname.startsWith(p));
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
}

// Build a name -> {kind, id} index over cities and agencies.
export function buildIndex(cities, agencies) {
  const idx = new Map();
  for (const c of Object.values(cities)) {
    const key = normName(c.name.replace(/ Twp$/, c.kind === "township" ? " township" : ""));
    // Cities win name collisions with townships ("Stillwater" is the city).
    if (!idx.has(key) || c.kind === "city") idx.set(key, { kind: "city", id: c.id });
  }
  for (const a of Object.values(agencies)) {
    idx.set(normName(a.name), { kind: "agency", id: a.id });
    idx.set(a.id, { kind: "agency", id: a.id });
  }
  return idx;
}

export function resolvePlace(idx, name) {
  const n = normName(name);
  return (
    idx.get(n) ||
    idx.get(n.replace(/ police( department)?$/, "")) ||
    idx.get(n.replace(/ county sheriffs? office$/, " county sheriff")) ||
    null
  );
}

/**
 * Decide what to do with each finding.
 * @param findings  extraction output (array)
 * @param ctx       { cities, agencies, today, knownUrls:Set<string> }
 * @returns array of { finding, target, action, reason }
 *   action: "apply" | "propose" | "skip"
 */
export function decide(findings, { cities, agencies, today, knownUrls }) {
  const idx = buildIndex(cities, agencies);
  const out = [];
  const appliedTargets = new Set();

  for (const f of findings) {
    const target = resolvePlace(idx, f.place);
    const rec = target && (target.kind === "city" ? cities[target.id] : agencies[target.id]);
    const push = (action, reason) => out.push({ finding: f, target, action, reason });

    if (!rec) {
      push("skip", `no tracked place named "${f.place}"`);
      continue;
    }
    if (!STATUSES.includes(f.proposed_status)) {
      push("skip", `invalid status "${f.proposed_status}"`);
      continue;
    }
    if (f.proposed_status === "unknown") {
      push("skip", "finding does not establish a status");
      continue;
    }
    if (f.proposed_status === rec.status) {
      push("skip", "matches current status");
      continue;
    }
    // The URL must be one the research step actually saw. This stops an
    // invented or mistyped link from ever reaching the live map.
    if (!f.url || !knownUrls.has(f.url)) {
      push("propose", "source URL was not among the search results");
      continue;
    }
    if (f.effective_date && rec.since && f.effective_date < rec.since) {
      push("skip", `older than current status (${rec.since})`);
      continue;
    }

    const reasons = [];
    // Statuses an editor set by hand are never overwritten automatically.
    if (rec.set_by === "manual") reasons.push("status was set by an editor");
    if (f.confidence !== "high") reasons.push(`confidence ${f.confidence}`);
    if (!f.conclusive) reasons.push("not a completed action");
    if (!isTrustedSource(f.url)) reasons.push("source not on trusted list");
    if (!f.effective_date) reasons.push("no effective date");
    else {
      const age = daysBetween(f.effective_date, today);
      if (age > AUTO_APPLY_MAX_AGE_DAYS) reasons.push(`${age} days old`);
      if (age < -1) reasons.push("dated in the future");
    }
    const key = `${target.kind}:${target.id}`;
    if (appliedTargets.has(key)) reasons.push("second finding for the same place this run");

    if (reasons.length) push("propose", reasons.join("; "));
    else {
      appliedTargets.add(key);
      push("apply", "high confidence, conclusive, trusted source, recent");
    }
  }
  return out;
}

// Mutates rec and returns a history entry.
export function applyFinding(rec, target, f, today) {
  const from = rec.status;
  rec.status = f.proposed_status;
  if (f.vendor) rec.vendor = f.vendor;
  if (Number.isFinite(f.cameras)) {
    if ("cameras_reported" in rec) rec.cameras_reported = f.cameras;
    else rec.cameras = f.cameras;
  }
  if (typeof f.sharing_restricted === "boolean") rec.sharing_restricted = f.sharing_restricted;
  rec.since = f.effective_date;
  rec.summary = f.summary;
  rec.confidence = f.confidence;
  rec.last_reviewed = today;
  rec.set_by = "ai";
  // A source can be a link, or an editor's note with no link.
  const source = f.url
    ? { url: f.url, title: f.title || f.url, outlet: f.outlet || "", date: f.effective_date || today }
    : { url: null, title: f.title || "Editor note", outlet: f.outlet || "Reader Map editor", date: f.effective_date || today };
  rec.sources = [source, ...(rec.sources || []).filter((s) => !f.url || s.url !== f.url)].slice(0, 6);
  return {
    date: f.effective_date || today,
    [target.kind]: target.id,
    type: "status",
    from,
    to: f.proposed_status,
    summary: f.summary,
    source: f.url,
    by: "ai",
    recorded: today,
  };
}
