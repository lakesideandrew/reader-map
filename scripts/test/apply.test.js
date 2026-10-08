import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, applyFinding, isTrustedSource, buildIndex, resolvePlace } from "../lib/apply.js";
import { pickTargets } from "../ai-news-check.js";

const TODAY = "2026-10-07";
const city = (id, name, extra = {}) => ({
  id, name, kind: "city", counties: ["Hennepin"], status: "unknown", vendor: null, cameras_reported: null,
  sharing_restricted: false, since: null, summary: "", sources: [], confidence: null, covered_by: [], ...extra,
});
const fixtures = () => ({
  cities: {
    1: city("1", "Richfield", { status: "active", vendor: "Flock Safety", since: "2026-09-04", confidence: "high" }),
    2: city("2", "Bloomington"),
    3: city("3", "Stillwater", { status: "active" }),
    4: { ...city("4", "Stillwater Twp"), kind: "township" },
    5: city("5", "Saint Paul", { status: "cancelled", since: "2026-08-26" }),
  },
  agencies: { "hennepin-sheriff": { id: "hennepin-sheriff", name: "Hennepin County Sheriff", status: "active", since: "2026-10-01" } },
});
const URL_STRIB = "https://www.startribune.com/richfield-ends-flock/123";
const base = {
  place: "Richfield", proposed_status: "cancelled", vendor: "Flock Safety", cameras: null, sharing_restricted: null,
  effective_date: "2026-10-05", summary: "Council voted to end the contract.", evidence: "Vote 4-1.",
  url: URL_STRIB, title: "Richfield ends Flock", outlet: "Star Tribune", confidence: "high", conclusive: true,
};
const run = (findings, urls = [URL_STRIB]) => decide(findings, { ...fixtures(), today: TODAY, knownUrls: new Set(urls) });

test("trusted sources", () => {
  assert.ok(isTrustedSource("https://www.startribune.com/x"));
  assert.ok(isTrustedSource("https://plymouthmn.gov/news/1"));
  assert.ok(isTrustedSource("https://www.ci.mound.mn.us/agenda"));
  assert.ok(isTrustedSource("https://www.cbsnews.com/minnesota/news/x"));
  assert.ok(!isTrustedSource("https://www.cbsnews.com/news/x"));
  assert.ok(isTrustedSource("https://www.axios.com/local/twin-cities/2026/x"));
  assert.ok(!isTrustedSource("https://hoodline.com/2026/x"));
  assert.ok(!isTrustedSource("https://startribune.com.evil.example/x"));
  assert.ok(!isTrustedSource("javascript:alert(1)"));
});

test("auto-applies a conclusive, recent, trusted, high-confidence change", () => {
  const [d] = run([base]);
  assert.equal(d.action, "apply", d.reason);
});

test("queues when any condition fails", () => {
  assert.equal(run([{ ...base, confidence: "medium" }])[0].action, "propose");
  assert.equal(run([{ ...base, conclusive: false }])[0].action, "propose");
  // Older than 60 days, on a place with no prior status date.
  const old = run([{ ...base, place: "Bloomington", proposed_status: "none", effective_date: "2026-06-01" }]);
  assert.equal(old[0].action, "propose");
  assert.match(old[0].reason, /days old/);
  assert.equal(run([{ ...base, effective_date: null }])[0].action, "propose");
  const hood = "https://hoodline.com/x";
  assert.equal(run([{ ...base, url: hood }], [hood])[0].action, "propose");
});

test("never applies a URL the research step did not see", () => {
  const [d] = run([base], []);
  assert.equal(d.action, "propose");
  assert.match(d.reason, /not among the search results/);
});

test("skips unchanged, unknown, stale and untracked findings", () => {
  assert.equal(run([{ ...base, proposed_status: "active" }])[0].action, "skip");
  assert.equal(run([{ ...base, proposed_status: "unknown" }])[0].action, "skip");
  assert.equal(run([{ ...base, effective_date: "2026-08-01" }])[0].action, "skip");
  assert.equal(run([{ ...base, place: "Duluth" }])[0].action, "skip");
});

test("only one automatic change per place per run", () => {
  const ds = run([base, { ...base, proposed_status: "pending" }]);
  assert.deepEqual(ds.map((d) => d.action), ["apply", "propose"]);
});

test("name resolution: St./Saint, sheriff variants, city beats township", () => {
  const { cities, agencies } = fixtures();
  const idx = buildIndex(cities, agencies);
  assert.deepEqual(resolvePlace(idx, "St. Paul"), { kind: "city", id: "5" });
  assert.deepEqual(resolvePlace(idx, "Stillwater"), { kind: "city", id: "3" });
  assert.deepEqual(resolvePlace(idx, "Stillwater Township"), { kind: "city", id: "4" });
  assert.deepEqual(resolvePlace(idx, "Hennepin County Sheriff's Office"), { kind: "agency", id: "hennepin-sheriff" });
});

test("applyFinding updates the record and returns a history entry", () => {
  const { cities } = fixtures();
  const rec = cities[1];
  const h = applyFinding(rec, { kind: "city", id: "1" }, base, TODAY);
  assert.equal(rec.status, "cancelled");
  assert.equal(rec.since, "2026-10-05");
  assert.equal(rec.sources[0].url, URL_STRIB);
  assert.deepEqual([h.from, h.to, h.by, h.city], ["active", "cancelled", "ai", "1"]);
});

test("pickTargets: watches pending/low-confidence, rotates unknown cities, ignores townships", () => {
  const cities = {
    a: city("a", "A", { status: "pending" }),
    b: city("b", "B", { confidence: "low", status: "active" }),
    c: city("c", "C", { population: 100 }),
    d: city("d", "D", { population: 9000 }),
    e: city("e", "E", { last_ai_check: "2026-09-01", population: 50000 }),
    t: { ...city("t", "T Twp"), kind: "township" },
  };
  const batches = pickTargets(cities, {});
  assert.deepEqual(batches[0].places.map((p) => p.id), ["a", "b"]);
  assert.deepEqual(batches[1].places.map((p) => p.id), ["d", "c", "e"]);
});

test("editor-set statuses are queued, never auto-applied", () => {
  const ctx = fixtures();
  ctx.cities[1].set_by = "manual";
  const [d] = decide([base], { ...ctx, today: TODAY, knownUrls: new Set([URL_STRIB]) });
  assert.equal(d.action, "propose");
  assert.match(d.reason, /set by an editor/);
});

test("editor notes without a URL become a link-free source", () => {
  const { cities } = fixtures();
  applyFinding(cities[2], { kind: "city", id: "2" }, { ...base, place: "Bloomington", url: null, title: "Editor note", outlet: "Reader Map editor" }, TODAY);
  assert.deepEqual([cities[2].sources[0].url, cities[2].sources[0].title], [null, "Editor note"]);
});
