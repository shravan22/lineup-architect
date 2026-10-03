import "server-only";
import { qlooMode } from "@/lib/qloo/client";
import type { AgentEvent, LlmInfo, VenueInput, Workspace } from "@/lib/types";
import { selectProvider, type Msg } from "./llm";
import { runTool, templatePitch, TOOL_LABELS, TOOL_SPECS } from "./tools";

type Emit = (e: AgentEvent) => void;

const MAX_TURNS = 16;
// In sample mode responses are instant; a short pause per step keeps the
// streamed trace readable. It is not used in live mode.
const FIXTURE_PACING_MS = 450;

const SCRIPTED_INFO: LlmInfo = { provider: "scripted", label: "Scripted planner (no LLM key)" };

export function llmInfo(): LlmInfo {
  return selectProvider()?.info ?? SCRIPTED_INFO;
}

function emptyWorkspace(venue: VenueInput): Workspace {
  return { venue, seeds: [], genreTags: [], tasteTags: [], picks: [], heatmap: [], heatmapSubject: [], demographics: [], brands: [], places: [] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function step(name: string, args: Record<string, unknown>, ws: Workspace, emit: Emit) {
  const id = crypto.randomUUID();
  emit({ type: "tool_start", id, name, label: TOOL_LABELS[name] ?? name, args: publicArgs(args) });
  if (qlooMode() === "fixture") await sleep(FIXTURE_PACING_MS);
  const t0 = Date.now(); // timing excludes the sample-mode pacing pause
  try {
    const out = await runTool(name, args, ws);
    emit({ type: "tool_end", id, ok: true, summary: out.summary, ms: Date.now() - t0, sources: out.sources, endpoints: out.endpoints });
    emit({ type: "workspace", workspace: ws });
    return { ok: true as const, content: out.forModel };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "tool_end", id, ok: false, summary: msg, ms: Date.now() - t0, sources: [], endpoints: [] });
    return { ok: false as const, content: `Error: ${msg}` };
  }
}

function publicArgs(args: Record<string, unknown>) {
  const { __template, ...rest } = args;
  void __template;
  return rest;
}

const SCRIPTED_PLAN: { tool: string; args: (ws: Workspace) => Record<string, unknown>; thought: string; done: (ws: Workspace) => boolean }[] = [
  { tool: "find_genre_tags", args: (ws) => ({ query: ws.venue.genreHint }), thought: "Look up Qloo genre tags for the venue's sound.", done: (ws) => ws.genreTags.length > 0 },
  { tool: "taste_profile", args: () => ({}), thought: "Summarise the past headliners as a taste profile.", done: (ws) => ws.tasteTags.length > 0 },
  { tool: "recommend_artists", args: () => ({ take: 10 }), thought: "Rank acts by affinity to the headliners, localised to the city.", done: (ws) => ws.picks.length > 0 },
  { tool: "audience_heatmap", args: () => ({}), thought: "Map where the top candidates' affinity is strongest locally.", done: (ws) => ws.heatmap.length > 0 },
  { tool: "audience_demographics", args: () => ({}), thought: "Check who the crowd is: age and gender skew.", done: (ws) => ws.demographics.length > 0 },
  { tool: "sponsor_brands", args: () => ({ take: 8 }), thought: "Find brands this crowd over-indexes on, for sponsorship.", done: (ws) => ws.brands.length > 0 },
  { tool: "partner_places", args: () => ({ take: 6 }), thought: "Find nearby spots this crowd loves for partner nights.", done: (ws) => ws.places.length > 0 },
];

/** Deterministic planner: same tool sequence as the LLM agent, no model involved. Skips steps already done. */
async function runScripted(ws: Workspace, emit: Emit) {
  for (const h of ws.venue.headliners) {
    if (ws.seeds.some((s) => s.query.toLowerCase() === h.toLowerCase())) continue;
    emit({ type: "thought", by: "scripted", text: `Resolve past headliner "${h}" to a Qloo entity.` });
    await step("search_artist", { name: h }, ws, emit);
  }
  for (const s of SCRIPTED_PLAN) {
    if (s.done(ws)) continue;
    emit({ type: "thought", by: "scripted", text: s.thought });
    await step(s.tool, s.args(ws), ws, emit);
  }
  if (!ws.pitch && ws.picks.length) {
    emit({ type: "thought", by: "scripted", text: "Draft the pitch from the collected Qloo facts (template)." });
    const t = templatePitch(ws);
    await step("write_pitch", { headline: t.headline, summary: t.summary, pick_rationales: t.pickRationales, sponsor_angle: t.sponsorAngle, __template: true }, ws, emit);
  }
}

function systemPrompt(v: VenueInput) {
  return [
    "You are Lineup Architect, a booking agent for independent venues. You use Qloo taste data tools to decide which touring acts a venue should book and how to pitch the night to sponsors.",
    "Work step by step: resolve every past headliner with search_artist, look up genre tags, build the taste profile, rank candidates, then check local affinity (heatmap), audience demographics, sponsor brands and partner places. Finish with write_pitch.",
    "Before each tool call, say in one short sentence why you are calling it. Use only facts returned by tools. Treat affinity as correlation, never causation, and never make claims about individuals.",
    `Venue: ${v.name}, ${v.city}, capacity ${v.capacity}. ${v.blurb}`,
    `Past headliners: ${v.headliners.join(", ")}. Genre focus: ${v.genreHint}.`,
  ].join("\n");
}

export async function runAgent(venue: VenueInput, emit: Emit): Promise<void> {
  const ws = emptyWorkspace(venue);
  const provider = selectProvider();
  emit({ type: "meta", qlooMode: qlooMode(), llm: provider?.info ?? SCRIPTED_INFO });
  emit({ type: "workspace", workspace: ws });

  if (!provider) {
    await runScripted(ws, emit);
    emit({ type: "done" });
    return;
  }

  const messages: Msg[] = [{ role: "user", text: `Plan the next booking for ${venue.name} and produce the pitch.` }];
  try {
    for (let turn = 0; turn < MAX_TURNS && !ws.pitch; turn++) {
      const out = await provider.next(systemPrompt(venue), messages, TOOL_SPECS);
      if (out.text) emit({ type: "thought", by: "llm", text: out.text });
      messages.push({ role: "assistant", text: out.text, toolCalls: out.toolCalls, raw: out.raw });
      if (!out.toolCalls.length) break;
      const results = [];
      for (const call of out.toolCalls) {
        const r = await step(call.name, call.args, ws, emit);
        results.push({ id: call.id, name: call.name, content: r.content, isError: !r.ok });
      }
      messages.push({ role: "tool", results });
    }
  } catch (e) {
    emit({ type: "notice", text: `LLM unavailable (${e instanceof Error ? e.message : "error"}). Finishing with the scripted planner.` });
  }
  if (!ws.pitch) {
    // Fill any gaps deterministically so the user always gets a complete result.
    await runScripted(ws, emit);
  }
  emit({ type: "done" });
}
