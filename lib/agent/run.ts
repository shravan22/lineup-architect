import "server-only";
import { bandLabel, capAtCeiling, capacityBand, searchBand, widen } from "@/lib/band";
import { qlooMode } from "@/lib/qloo/client";
import { hasFixtures, recordedOn } from "@/lib/qloo/fixtures";
import type { AgentEvent, LlmInfo, VenueInput, Workspace } from "@/lib/types";
import { isQuotaError, isTransientError, llmErrorText, LlmTimeout, selectProvider, selectProviders, type LlmProvider, type Msg } from "./llm";
import { bookableCount, chooseCandidate, DEFAULT_TAKE, MIN_FIT, runTool, templatePitch, TOOL_LABELS, TOOL_SPECS } from "./tools";

type Emit = (e: AgentEvent) => void;
type By = "llm" | "scripted";

// Vercel's function limit is 60 s (route.ts maxDuration). The agent stops
// starting new work once its budget is spent and streams what it has.
const MAX_TURNS = 8;
const BUDGET_MS = Number(process.env.AGENT_BUDGET_MS) || 50_000;
/** Time kept back at the end for the template pitch and closing the stream. */
const RESERVE_MS = 1_500;
// In recorded mode responses are instant; a short pause per step keeps the
// streamed trace readable. It is not used in live mode.
const FIXTURE_PACING_MS = 450;

const SCRIPTED_INFO: LlmInfo = {
  provider: "scripted",
  label: (process.env.LLM_PROVIDER ?? "").trim().toLowerCase() === "scripted" ? "Scripted planner (LLM_PROVIDER=scripted)" : "Scripted planner (no LLM key)",
};

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

// Time kept back for the scripted planner to finish a live run (~5 s measured) after
// handing over from a slow or failing LLM. Gemini 3.8 Flash took 9-29 s per call live.
const HANDOVER_MS = 14_000;
// Per model call. A healthy Flash-Lite / Haiku planning turn takes 1-3 s; on 2026-10-13
// a degraded Gemini first call hung for 35 s. Aborting at 8 s lets the next provider
// (or the scripted planner) take over quickly.
const LLM_CALL_TIMEOUT_MS = Number(process.env.LLM_CALL_TIMEOUT_MS) || 8_000; // empty or invalid: default
// Once picks exist the next turns write the pitch (long output): Haiku took 7.3-8+ s and
// Flash-Lite 7.4-8+ s live on 2026-10-16, so 8 s cut good pitches off. Still capped by the budget.
const PITCH_CALL_TIMEOUT_MS = Number(process.env.PITCH_CALL_TIMEOUT_MS) || 18_000;

function withTimeout<T>(p: Promise<T>, ms: number, err: () => Error = () => new OutOfTime()): Promise<T> {
  if (ms <= 0) return Promise.reject(err());
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(err()), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** One model call, aborted after `ms` (LlmTimeout). */
async function callWithTimeout(p: LlmProvider, system: string, messages: Msg[], ms: number) {
  const ac = new AbortController();
  const err = new LlmTimeout(ms);
  const t = setTimeout(() => ac.abort(err), ms);
  try {
    // Race as well as abort, in case an SDK ignores the signal.
    return await Promise.race([
      p.next(system, messages, TOOL_SPECS, ac.signal),
      new Promise<never>((_, reject) => ac.signal.addEventListener("abort", () => reject(err), { once: true })),
    ]);
  } catch (e) {
    throw ac.signal.aborted ? err : e;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Provider-neutral restart prompt for the next provider in the chain: the earlier
 * provider's turns are replayed as text (its raw content, e.g. Gemini thought
 * signatures, cannot be sent to another provider). The workspace already holds the results.
 */
function resumePrompt(task: string, messages: Msg[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      if (m.text) lines.push(`Planner: ${m.text}`);
      for (const tc of m.toolCalls) lines.push(`Called ${tc.name}(${JSON.stringify(tc.args)})`);
    } else if (m.role === "tool") {
      for (const r of m.results) lines.push(`Result of ${r.name}${r.isError ? " (error)" : ""}: ${r.content.slice(0, 1500)}`);
    }
  }
  if (!lines.length) return task;
  return [task, "Another planner already ran these steps; their results are saved. Continue from here and do not repeat them.", ...lines].join("\n");
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
  const t0 = Date.now(); // timing excludes the recorded-mode pacing pause
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
    const search = searchBand(ws.venue.capacity);
    thought(
      c,
      `A ${ws.venue.capacity}-cap room maps to Qloo popularity ${bandLabel(target)} (a heuristic for draw). Rank acts in ${bandLabel(search)}, a little above the room's ceiling so stretch picks are visible, with ${ws.venue.city} as the location signal.`,
    );
    await step("recommend_artists", { take: DEFAULT_TAKE }, by, c);
    let moved = false;

    // Stretch acts crowd the shortlist: cap the query at the room's ceiling.
    if (ws.band && countTier(ws, "fits") < MIN_FIT && countTier(ws, "stretch") > 0 && ws.band.used.max > ws.band.target.max) {
      const next = capAtCeiling(ws.band.used, ws.band.target);
      thought(c, `Only ${countTier(ws, "fits")} of ${ws.picks.length} acts are in this room's tier; ${countTier(ws, "stretch")} are stretch picks. Cap the search at the room's ceiling and re-query.`);
      await step(
        "recommend_artists",
        {
          popularity_min: next.min,
          popularity_max: next.max,
          take: DEFAULT_TAKE,
          reason: `Only ${countTier(ws, "fits")} acts were in the room's tier ${bandLabel(ws.band.target)} and ${countTier(ws, "stretch")} were stretch picks. Capped the search at ${bandLabel(next)} to surface acts a ${ws.venue.capacity}-cap room can book; the two strongest stretch picks stay on the list as reach options.`,
        },
        by,
        c,
      );
      moved = true;
    }

    // Too few acts at or below the ceiling: widen downwards, at most twice, and stop if a re-query changes nothing.
    for (let i = 0; i < 2 && ws.band && countBookable(ws) < MIN_FIT; i++) {
      const next = widen(ws.band.used);
      const n = ws.band.history.length;
      thought(c, `Only ${countBookable(ws)} acts are at or below the room's ceiling; I need at least ${MIN_FIT}. Widen the band downwards and re-query.`);
      await step(
        "recommend_artists",
        {
          popularity_min: next.min,
          popularity_max: next.max,
          take: DEFAULT_TAKE,
          reason: `Only ${countBookable(ws)} acts inside ${bandLabel(ws.band.used)} at or below the room's ceiling (need ${MIN_FIT}). Widened to ${bandLabel(next)}; acts below the room's tier are flagged as under-draw.`,
        },
        by,
        c,
      );
      moved = true;
      if (ws.band.history.length > n && ws.band.history[ws.band.history.length - 1].includes("reverted")) break;
    }

    if (ws.band && !moved) {
      const st = countTier(ws, "stretch");
      c.emit({
        type: "decision",
        by,
        title: `Kept the ${bandLabel(ws.band.used)} search`,
        detail: `${countTier(ws, "fits")} of ${ws.picks.length} acts are in a ${ws.venue.capacity}-cap room's tier (need at least ${MIN_FIT})${st ? `; ${st} stretch pick${st === 1 ? "" : "s"} stay on the list, ranked last, as reach options` : ""}. No re-query needed.`,
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

function countTier(ws: Workspace, fit: "fits" | "stretch"): number {
  return ws.picks.filter((p) => p.drawFit === fit).length;
}

function countBookable(ws: Workspace): number {
  return ws.band ? bookableCount(ws.picks, ws.band.used, ws.band.target) : 0;
}

function systemPrompt(v: VenueInput) {
  const band = capacityBand(v.capacity);
  return [
    "You are Lineup Architect, a booking agent for independent venues. You use Qloo taste-data tools to decide which touring acts this venue should book and how to pitch the night to sponsors.",
    "Goal: a shortlist of acts the room can actually book and fill, the local crowd behind them, sponsor brands, partner spots, and a pitch (write_pitch ends the run).",
    "You decide the plan. Rules:",
    "- Call independent tools in the same turn (they run in parallel). You have at most 8 turns, so batch: e.g. all search_artist calls plus find_genre_tags together; later heatmap, demographics, brands and places together.",
    "- If search_artist reports several candidates, call resolve_headliner and pick the one that matches the venue's genre. Give a one-sentence reason.",
    `- The room's capacity maps to Qloo popularity ${bandLabel(band)} (0..1 percentile; a heuristic for draw, not a ticket forecast). By default recommend_artists searches ${bandLabel(searchBand(v.capacity))}, a little above the ceiling, so acts above it come back flagged as stretch. Follow the tool's advice: if fewer than ${MIN_FIT} acts are in tier because stretch acts take the slots, cap popularity_max at ${band.max}; if fewer than ${MIN_FIT} acts are at or below the ceiling, lower popularity_min. Always give a reason when you change the band. A re-query that adds fewer than 2 new acts is reverted automatically.`,
    "- Pick which acts to map and profile (default: the top 3 that fit the room).",
    "- recommend_artists returns Qloo explainability (driven_by: which past headliner drove each act, 0..1). Cite it in pick_rationales when present.",
    "- If a tool reports unavailable (HTTP 403, not enabled for this key), do not retry it; continue and finish the pitch without that section.",
    "Before each batch of tool calls, say in one short sentence what you are deciding and why. Use only facts returned by tools. Treat affinity as correlation, never causation, and never make claims about individuals. Never promise outcomes such as attendance, sell-outs or revenue (no 'guarantees', 'packed', 'sure-fire'); say what the Qloo data shows. Only describe local taste as concentrated near the venue if audience_heatmap reports near_venue_lift above 1.1; otherwise say taste is spread across the city or leave it out. Never write 'strong local affinity' unless that lift is above 1.1. Call stretch acts 'stretch picks', never 'fits the room'. The pitch is checked against the data; unsupported claims are replaced by the template pitch.",
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
    `Rank acts (with ${v.city} as location signal) for a ${v.capacity}-cap room whose tier is popularity ${bandLabel(band)}, capping the search at that ceiling or widening it if too few acts are in tier`,
    "Map local affinity, profile the audience, shortlist sponsor brands and partner spots (4 Qloo insights calls in parallel)",
    "Draft the booking pitch",
  ];
}

/** Switches the badge to the scripted planner (truthfully), lets it finish, then says why. */
async function handover(c: Ctx, llmLabel: string, why: string, notice: string) {
  c.emit({ type: "meta", qlooMode: qlooMode(), llm: { provider: "scripted", label: `Scripted planner (${llmLabel} ${why})` }, recordedOn: recordedOn() });
  c.emit({ type: "thought", by: "system", text: `Handing over to the scripted planner: ${llmLabel} ${why}.` });
  if (!c.ws.pitch) await runScripted(c);
  c.emit({ type: "notice", text: notice });
}

export async function runAgent(venue: VenueInput, emit: Emit): Promise<void> {
  const dl = new Deadline(BUDGET_MS);
  const ws = emptyWorkspace(venue);
  const c: Ctx = { ws, emit, dl };
  const chain = selectProviders();
  const llmMs: number[] = []; // per model call latency, reported in the done event
  const llmStart = Date.now();
  let llmTries = 0; // includes a call abandoned at the handover deadline
  emit({ type: "meta", qlooMode: qlooMode(), llm: chain[0]?.info ?? SCRIPTED_INFO, recordedOn: recordedOn() });

  if (qlooMode() === "fixture" && !hasFixtures(venue.fixtureSet)) {
    emit({
      type: "needs_live",
      text: `Recorded mode (no Qloo key) covers only the five preset venues. Running ${venue.name} needs a live Qloo API key, and the app will not invent taste data for it.`,
      plan: livePlan(venue),
    });
    emit({ type: "done", elapsedMs: dl.elapsed() });
    return;
  }
  emit({ type: "workspace", workspace: ws });

  try {
    if (venue.needsGeocode) await step("locate_city", {}, "scripted", c);

    if (!chain.length) {
      await runScripted(c);
    } else {
      const task = `Plan the next booking for ${venue.name} and produce the pitch.`;
      let messages: Msg[] = [{ role: "user", text: task }];
      let pi = 0; // index of the provider planning now
      let turn = 0;
      let retried = false; // one retry per provider
      const tried: string[] = []; // failure notes of earlier providers, for the final notice
      // Hands over to the next provider in the chain (true) or reports there is none (false).
      const nextProvider = (why: string): boolean => {
        const from = chain[pi].info.label;
        tried.push(`${from} ${why}`);
        if (pi + 1 >= chain.length) return false;
        pi++;
        retried = false;
        const to = chain[pi];
        emit({ type: "meta", qlooMode: qlooMode(), llm: { ...to.info, note: `fallback after ${from} ${why}` }, recordedOn: recordedOn() });
        emit({ type: "thought", by: "system", text: `Switching planner: ${from} ${why}; ${to.info.label} continues from the work done so far.` });
        emit({ type: "notice", text: `${from} ${why}; switched to ${to.info.label} for the remaining turns.` });
        messages = [{ role: "user", text: resumePrompt(task, messages) }];
        return true;
      };
      let failure: { why: string; kind: "slow" | "quota" | "failed" } | null = null;
      while (turn < MAX_TURNS && !ws.pitch) {
        if (dl.expired()) throw new OutOfTime();
        const llmLeft = dl.left() - HANDOVER_MS;
        if (llmLeft < 3_000) {
          failure = { why: "too slow", kind: "slow" };
          tried.push(`${chain[pi].info.label} out of planning time`);
          break;
        }
        const provider = chain[pi];
        const callMs = Math.min(ws.picks.length ? PITCH_CALL_TIMEOUT_MS : LLM_CALL_TIMEOUT_MS, llmLeft);
        const tCall = Date.now();
        llmTries++;
        let out;
        try {
          out = await callWithTimeout(provider, systemPrompt(venue), messages, callMs);
          llmMs.push(Date.now() - tCall);
        } catch (e) {
          llmMs.push(Date.now() - tCall);
          if (e instanceof OutOfTime) throw e;
          const timedOut = e instanceof LlmTimeout;
          const quota = !timedOut && isQuotaError(e);
          const why = timedOut ? `timed out (no reply in ${(callMs / 1000).toFixed(0)} s)` : quota ? `quota reached (${llmErrorText(e)})` : `failed (${llmErrorText(e)})`;
          // 5xx / connection errors are usually transient: one retry per provider, if time allows.
          if (!retried && isTransientError(e) && dl.left() - HANDOVER_MS > 6_000) {
            retried = true;
            emit({ type: "thought", by: "system", text: `${provider.info.label} ${why}; retrying once.` });
            await sleep(1_000);
            continue;
          }
          if (nextProvider(why)) continue;
          failure = { why, kind: timedOut ? "slow" : quota ? "quota" : "failed" };
          break;
        }
        turn++;
        if (out.text) emit({ type: "thought", by: "llm", text: out.text });
        messages.push({ role: "assistant", text: out.text, toolCalls: out.toolCalls, raw: out.raw });
        if (!out.toolCalls.length) break;
        // Tool calls in one turn are independent by contract: run them concurrently.
        const res = await Promise.all(out.toolCalls.map((call) => step(call.name, call.args, "llm", c)));
        messages.push({ role: "tool", results: out.toolCalls.map((call, i) => ({ id: call.id, name: call.name, content: res[i].content, isError: !res[i].ok })) });
      }
      if (!ws.pitch) {
        const label = chain[pi].info.label;
        const spent = `${((Date.now() - llmStart) / 1000).toFixed(0)} s over ${llmTries} call${llmTries === 1 ? "" : "s"}`;
        // Every provider's failure, in order (the last one is the reason for this handover).
        const what = tried.join("; then ");
        if (!failure) await handover(c, label, "stopped early", `The model stopped before finishing (turn cap ${MAX_TURNS}); the scripted planner finished the run.`);
        else if (failure.kind === "slow") await handover(c, label, "too slow", `LLM too slow: ${what} (${spent}). The scripted planner finished the run.`);
        else if (failure.kind === "quota") await handover(c, label, "quota reached", `LLM quota reached: ${what}. The scripted planner finished the run.`);
        else await handover(c, label, "failed", `LLM unavailable: ${what}. The scripted planner finished the run.`);
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
  emit({ type: "done", partial: ws.partial, elapsedMs: dl.elapsed(), llmCalls: chain.length ? { n: llmTries, ms: llmMs } : undefined });
}
