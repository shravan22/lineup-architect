import "server-only";
import { bandLabel, capacityBand, narrowTop, widen } from "@/lib/band";
import { qlooMode } from "@/lib/qloo/client";
import { hasFixtures } from "@/lib/qloo/fixtures";
import type { AgentEvent, LlmInfo, VenueInput, Workspace } from "@/lib/types";
import { selectProvider, type Msg } from "./llm";
import { chooseCandidate, DEFAULT_TAKE, MIN_FIT, runTool, templatePitch, TOOL_LABELS, TOOL_SPECS } from "./tools";

type Emit = (e: AgentEvent) => void;
type By = "llm" | "scripted";

// Vercel's function limit is 60 s (route.ts maxDuration). The agent stops
// starting new work once its budget is spent and streams what it has.
const MAX_TURNS = 8;
const BUDGET_MS = Number(process.env.AGENT_BUDGET_MS ?? 50_000);
/** Time kept back at the end for the template pitch and closing the stream. */
const RESERVE_MS = 1_500;
// In sample mode responses are instant; a short pause per step keeps the
// streamed trace readable. It is not used in live mode.
const FIXTURE_PACING_MS = 450;

const SCRIPTED_INFO: LlmInfo = { provider: "scripted", label: "Scripted planner (no LLM key)" };

export function llmInfo(): LlmInfo {
  return selectProvider()?.info ?? SCRIPTED_INFO;
}

class Deadline {
  private start = Date.now();
  constructor(private budget: number) {}
  elapsed() {
    return Date.now() - this.start;
  }
  left() {
    return this.budget - this.elapsed() - RESERVE_MS;
  }
  expired() {
    return this.left() <= 0;
  }
}

class OutOfTime extends Error {
  constructor() {
    super("time budget reached");
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new OutOfTime());
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new OutOfTime()), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

function emptyWorkspace(venue: VenueInput): Workspace {
  return { venue, seeds: [], genreTags: [], tasteTags: [], picks: [], heatmap: [], heatmapSubject: [], demographics: [], brands: [], places: [], pending: [], unavailable: [] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ctx {
  ws: Workspace;
  emit: Emit;
  dl: Deadline;
}

async function step(name: string, args: Record<string, unknown>, by: By, { ws, emit, dl }: Ctx) {
  const id = crypto.randomUUID();
  emit({ type: "tool_start", id, name, label: TOOL_LABELS[name] ?? name, args: publicArgs(args) });
  if (qlooMode() === "fixture") await sleep(FIXTURE_PACING_MS);
  const t0 = Date.now(); // timing excludes the sample-mode pacing pause
  try {
    const out = await withTimeout(runTool(name, args, ws), dl.left());
    emit({ type: "tool_end", id, ok: true, unavailable: out.unavailable, summary: out.summary, ms: Date.now() - t0, sources: out.sources, endpoints: out.endpoints });
    for (const d of out.decisions ?? []) emit({ type: "decision", by, title: d.title, detail: d.detail });
    emit({ type: "workspace", workspace: ws });
    return { ok: true as const, content: out.forModel };
  } catch (e) {
    const msg = e instanceof OutOfTime ? "Stopped: time budget reached" : e instanceof Error ? e.message : String(e);
    emit({ type: "tool_end", id, ok: false, summary: msg, ms: Date.now() - t0, sources: [], endpoints: [] });
    if (e instanceof OutOfTime) throw e;
    return { ok: false as const, content: `Error: ${msg}` };
  }
}

/** Runs independent steps concurrently. */
function parallel(c: Ctx, by: By, calls: [string, Record<string, unknown>][]) {
  return Promise.all(calls.map(([n, a]) => step(n, a, by, c)));
}

function publicArgs(args: Record<string, unknown>) {
  const { __template, ...rest } = args;
  void __template;
  return rest;
}

function thought(c: Ctx, text: string) {
  c.emit({ type: "thought", by: "scripted", text });
}

/**
 * Deterministic planner (no model). It follows the same branch logic the LLM is
 * asked to use: disambiguate search hits, widen the popularity band when fewer
 * than MIN_FIT acts fit, narrow it for small rooms when the band is crowded.
 * Skips work that is already done, so it can also finish an interrupted LLM run.
 */
async function runScripted(c: Ctx) {
  const { ws } = c;
  const by: By = "scripted";

  const todo = ws.venue.headliners.filter(
    (h) => !ws.seeds.some((s) => s.query.toLowerCase() === h.toLowerCase()) && !ws.pending.some((p) => p.query.toLowerCase() === h.toLowerCase()),
  );
  const first: [string, Record<string, unknown>][] = todo.map((h) => ["search_artist", { name: h }]);
  if (ws.venue.genreHint && !ws.genreTags.length) first.push(["find_genre_tags", { query: ws.venue.genreHint }]);
  if (first.length) {
    thought(c, `Resolve ${todo.length ? `the past headliners (${todo.join(", ")})` : "nothing new"}${ws.venue.genreHint ? ` and look up genre tags for "${ws.venue.genreHint}"` : ""}, in parallel.`);
    await parallel(c, by, first);
  }

  for (const p of [...ws.pending]) {
    const pick = chooseCandidate(ws, p);
    thought(c, `"${p.query}" matched ${p.candidates.length} Qloo artists. Pick the one that fits this venue.`);
    await step("resolve_headliner", { query: p.query, entity_id: pick.entityId, reason: pick.reason }, by, c);
  }
  if (!ws.seeds.length) {
    c.emit({ type: "notice", text: "None of the past headliners matched a Qloo artist, so there is nothing to build a taste profile from." });
    return;
  }

  if (!ws.tasteTags.length && !ws.unavailable.includes("taste_profile")) {
    thought(c, "Summarise the past headliners as a taste profile.");
    await step("taste_profile", {}, by, c);
  }

  if (!ws.picks.length) {
    const target = capacityBand(ws.venue.capacity);
    thought(c, `A ${ws.venue.capacity}-cap room maps to Qloo popularity ${bandLabel(target)}. Rank acts inside that band, with ${ws.venue.city} as the location signal.`);
    await step("recommend_artists", { take: DEFAULT_TAKE }, by, c);

    // Too few fit: widen, at most twice.
    for (let i = 0; i < 2 && ws.band && countInBand(ws) < MIN_FIT; i++) {
      const next = widen(ws.band.used);
      thought(c, `Only ${countInBand(ws)} acts fit; I need at least ${MIN_FIT}. Widen the band and re-query.`);
      await step(
        "recommend_artists",
        {
          popularity_min: next.min,
          popularity_max: next.max,
          take: DEFAULT_TAKE,
          reason: `Only ${countInBand(ws)} acts inside ${bandLabel(ws.band.used)} (need ${MIN_FIT}). Widened to ${bandLabel(next)}; acts outside the room's band are flagged as stretch or under-draw.`,
        },
        by,
        c,
      );
    }

    // Crowded band for a small room: try trimming the top, keep it only if enough acts remain.
    if (ws.band && ws.venue.capacity <= 400 && ws.picks.length >= DEFAULT_TAKE && sameBand(ws.band.used, ws.band.target)) {
      const before = { picks: ws.picks, band: ws.band };
      const next = narrowTop(ws.band.used);
      thought(c, `${ws.picks.length} acts fit a ${ws.venue.capacity}-cap room. Lower the top of the band so the shortlist stays affordable.`);
      await step(
        "recommend_artists",
        {
          popularity_min: next.min,
          popularity_max: next.max,
          take: DEFAULT_TAKE,
          reason: `The ${bandLabel(ws.band.used)} band returned a full list for a ${ws.venue.capacity}-cap room. Narrowed the top to ${bandLabel(next)} to favour acts the room can afford.`,
        },
        by,
        c,
      );
      if (countInBand(ws) < MIN_FIT) {
        ws.picks = before.picks;
        ws.band = { ...before.band, history: [...ws.band.history, "reverted"] };
        c.emit({ type: "decision", by, title: "Kept the original band", detail: `Narrowing left fewer than ${MIN_FIT} acts, so the ${bandLabel(before.band.used)} results stand.` });
        c.emit({ type: "workspace", workspace: ws });
      }
    } else if (ws.band && sameBand(ws.band.used, ws.band.target) && countInBand(ws) >= MIN_FIT) {
      c.emit({
        type: "decision",
        by,
        title: `Kept the ${bandLabel(ws.band.target)} band`,
        detail: `${countInBand(ws)} acts fit a ${ws.venue.capacity}-cap room (need at least ${MIN_FIT}) and the list is not crowded, so no re-query is needed.`,
      });
    }
  }
  if (!ws.picks.length) return;

  const fan: [string, Record<string, unknown>][] = [];
  if (!ws.heatmap.length) fan.push(["audience_heatmap", {}]);
  if (!ws.demographics.length && !ws.unavailable.includes("demographics")) fan.push(["audience_demographics", {}]);
  if (!ws.brands.length) fan.push(["sponsor_brands", { take: 8 }]);
  if (!ws.places.length) fan.push(["partner_places", { take: 6 }]);
  if (fan.length) {
    thought(c, "Map local affinity, profile the crowd, and find sponsor brands and partner spots for the top bookable acts, in parallel.");
    await parallel(c, by, fan);
  }

  if (!ws.pitch) await writeTemplatePitch(c);
}

async function writeTemplatePitch(c: Ctx) {
  if (c.ws.pitch || !c.ws.picks.length) return;
  thought(c, "Draft the pitch from the collected Qloo facts (template).");
  const t = templatePitch(c.ws);
  try {
    await step("write_pitch", { headline: t.headline, summary: t.summary, pick_rationales: t.pickRationales, sponsor_angle: t.sponsorAngle, __template: true }, "scripted", c);
  } catch {
    // write_pitch is local and instant; never let the guard drop it.
    c.ws.pitch = t;
    c.emit({ type: "workspace", workspace: c.ws });
  }
}

const sameBand = (a: { min: number; max: number }, b: { min: number; max: number }) => a.min === b.min && a.max === b.max;

function countInBand(ws: Workspace): number {
  const b = ws.band?.used;
  if (!b) return 0;
  return ws.picks.filter((p) => p.popularity !== undefined && p.popularity >= b.min && p.popularity <= b.max).length;
}

function systemPrompt(v: VenueInput) {
  const band = capacityBand(v.capacity);
  return [
    "You are Lineup Architect, a booking agent for independent venues. You use Qloo taste-data tools to decide which touring acts this venue should book and how to pitch the night to sponsors.",
    "Goal: a shortlist of acts the room can actually book and fill, the local crowd behind them, sponsor brands, partner spots, and a pitch (write_pitch ends the run).",
    "You decide the plan. Rules:",
    "- Call independent tools in the same turn (they run in parallel). You have at most 8 turns, so batch: e.g. all search_artist calls plus find_genre_tags together; later heatmap, demographics, brands and places together.",
    "- If search_artist reports several candidates, call resolve_headliner and pick the one that matches the venue's genre. Give a one-sentence reason.",
    `- The room's capacity maps to Qloo popularity ${bandLabel(band)} (0..1 percentile). recommend_artists uses it by default. If fewer than ${MIN_FIT} acts fit, widen the band and re-query. If the band is crowded and the room is small, you may lower popularity_max. Always give a reason when you change the band.`,
    "- Pick which acts to map and profile (default: the top 3 that fit the room).",
    "- recommend_artists returns Qloo explainability (driven_by: which past headliner drove each act, 0..1). Cite it in pick_rationales when present.",
    "- If a tool reports unavailable (HTTP 403, not enabled for this key), do not retry it; continue and finish the pitch without that section.",
    "Before each batch of tool calls, say in one short sentence what you are deciding and why. Use only facts returned by tools. Treat affinity as correlation, never causation, and never make claims about individuals.",
    `Venue: ${v.name}, ${v.city}, capacity ${v.capacity}. ${v.blurb}`,
    `Past headliners: ${v.headliners.join(", ")}.${v.genreHint ? ` Genre focus: ${v.genreHint}.` : ""}`,
  ].join("\n");
}

/** Plan shown when a custom venue cannot run because there is no live Qloo key. */
export function livePlan(v: VenueInput): string[] {
  const band = capacityBand(v.capacity);
  return [
    ...(v.needsGeocode ? [`Locate "${v.locationQuery}" with Qloo /search (types=urn:entity:locality)`] : []),
    `Resolve ${v.headliners.map((h) => `"${h}"`).join(", ")} with Qloo /search, and disambiguate any duplicates`,
    ...(v.genreHint ? [`Look up genre tags for "${v.genreHint}" with Qloo /v2/tags`] : []),
    "Build the taste profile of those headliners (Qloo /v2/insights, urn:tag)",
    `Rank acts (with ${v.city} as location signal) inside popularity band ${bandLabel(band)} for a ${v.capacity}-cap room, widening or narrowing if needed`,
    "Map local affinity, profile the audience, shortlist sponsor brands and partner spots (4 Qloo insights calls in parallel)",
    "Draft the booking pitch",
  ];
}

export async function runAgent(venue: VenueInput, emit: Emit): Promise<void> {
  const dl = new Deadline(BUDGET_MS);
  const ws = emptyWorkspace(venue);
  const c: Ctx = { ws, emit, dl };
  const provider = selectProvider();
  emit({ type: "meta", qlooMode: qlooMode(), llm: provider?.info ?? SCRIPTED_INFO });

  if (qlooMode() === "fixture" && !hasFixtures(venue.fixtureSet)) {
    emit({
      type: "needs_live",
      text: `Sample-data mode covers only the five preset venues. Running ${venue.name} needs a live Qloo API key, and the app will not invent taste data for it.`,
      plan: livePlan(venue),
    });
    emit({ type: "done", elapsedMs: dl.elapsed() });
    return;
  }
  emit({ type: "workspace", workspace: ws });

  try {
    if (venue.needsGeocode) await step("locate_city", {}, "scripted", c);

    if (!provider) {
      await runScripted(c);
    } else {
      const messages: Msg[] = [{ role: "user", text: `Plan the next booking for ${venue.name} and produce the pitch.` }];
      try {
        for (let turn = 0; turn < MAX_TURNS && !ws.pitch; turn++) {
          if (dl.expired()) throw new OutOfTime();
          const out = await withTimeout(provider.next(systemPrompt(venue), messages, TOOL_SPECS), dl.left());
          if (out.text) emit({ type: "thought", by: "llm", text: out.text });
          messages.push({ role: "assistant", text: out.text, toolCalls: out.toolCalls, raw: out.raw });
          if (!out.toolCalls.length) break;
          // Tool calls in one turn are independent by contract: run them concurrently.
          const res = await Promise.all(out.toolCalls.map((call) => step(call.name, call.args, "llm", c)));
          messages.push({ role: "tool", results: out.toolCalls.map((call, i) => ({ id: call.id, name: call.name, content: res[i].content, isError: !res[i].ok })) });
        }
        if (!ws.pitch) emit({ type: "notice", text: `The model stopped before finishing (turn cap ${MAX_TURNS}). The scripted planner fills the remaining steps.` });
      } catch (e) {
        if (e instanceof OutOfTime) throw e;
        emit({ type: "notice", text: `LLM unavailable (${e instanceof Error ? e.message : "error"}). Finishing with the scripted planner.` });
      }
      if (!ws.pitch) await runScripted(c);
    }
  } catch (e) {
    if (!(e instanceof OutOfTime)) throw e;
    ws.partial = true;
    emit({
      type: "notice",
      text: `Time budget reached after ${(dl.elapsed() / 1000).toFixed(1)} s. Showing partial results${ws.picks.length ? " with a template pitch" : ""}.`,
    });
    await writeTemplatePitch({ ...c, dl: new Deadline(RESERVE_MS + 2_000) });
    emit({ type: "workspace", workspace: ws });
  }
  emit({ type: "done", partial: ws.partial, elapsedMs: dl.elapsed() });
}
