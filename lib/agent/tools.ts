import "server-only";
import { bandLabel, capacityBand, drawFit, MIN_BAND_WIDTH, searchBand } from "@/lib/band";
import { qloo, QlooError, type QlooCtx, type QlooResult } from "@/lib/qloo/client";
import {
  parseDemographics,
  parseEntities,
  parseExplainSummary,
  parseHeatmap,
  parseSearch,
  matchedLocality,
  parseTagList,
  toBrand,
  toPlace,
  type RawEntity,
} from "@/lib/qloo/normalize";
import type { ArtistPick, DataSource, Driver, PendingChoice, Pitch, PlacePick, PopBand, UnavailableSection, Workspace } from "@/lib/types";
import { NEAR_LIFT_MIN } from "@/lib/ui";

// Agent tools. Each tool calls Qloo (or the labelled recorded Qloo responses), writes
// structured results into the shared Workspace (which the UI renders), and
// returns a compact text result for the model. Qloo facts live in the
// Workspace; LLM text is only used for decisions and the pitch narrative.
//
// Two tools exist so the agent makes real choices:
//  - resolve_headliner: when /search returns more than one plausible artist
//  - recommend_artists(popularity_min/max): when too few or too many acts fit
//    the capacity band, the agent widens or narrows it and re-queries.

export interface JsonSchema {
  type: "object";
  properties: Record<string, { type: string; description: string; items?: { type: string; properties?: Record<string, { type: string; description: string }> } }>;
  required?: string[];
}

export interface ToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolOutcome {
  summary: string; // one line for the UI step list
  forModel: string; // compact result for the LLM
  sources: DataSource[];
  endpoints: string[];
  /** True when Qloo refused the endpoint for this key (403); the run continues without it. */
  unavailable?: boolean;
  /** Visible agent decisions made through this call (shown in the trace). */
  decisions?: { title: string; detail: string }[];
}

type Args = Record<string, unknown>;

/** Minimum number of acts inside the popularity band before the agent widens it. */
export const MIN_FIT = 6;
export const DEFAULT_TAKE = 10;

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "search_artist",
    label: "Resolve past headliner",
    description:
      "Look up one past headliner with Qloo /search. If exactly one artist matches it is resolved. If several plausible artists match, the result lists the candidates and you must call resolve_headliner to pick one.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Artist name exactly as the venue wrote it" } },
      required: ["name"],
    },
  },
  {
    name: "resolve_headliner",
    label: "Disambiguate headliner",
    description:
      "Pick which Qloo entity a past headliner refers to when search_artist returned several candidates. Use the venue's genre and the candidates' descriptions and tags. Explain the choice in `reason`.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The headliner name as searched" },
        entity_id: { type: "string", description: "The chosen candidate's entity_id" },
        reason: { type: "string", description: "One sentence: why this candidate" },
      },
      required: ["query", "entity_id", "reason"],
    },
  },
  {
    name: "find_genre_tags",
    label: "Look up genre tags",
    description: "Find the Qloo genre tag for a genre phrase using Qloo /v2/tags. The tag is used to disambiguate headliners and to match acts to the venue's genre.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Genre phrase, e.g. 'deep house'" } },
      required: ["query"],
    },
  },
  {
    name: "taste_profile",
    label: "Build venue taste profile",
    description:
      "Get the taste tags with the highest affinity to the resolved headliners (Qloo insights, filter.type=urn:tag). Requires every headliner to be resolved.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "recommend_artists",
    label: "Rank candidate acts",
    description:
      "Rank artists by Qloo affinity to the past headliners (the venue's city is sent as a location signal; the result says whether Qloo applied it), restricted to a Qloo popularity band (filter.popularity.min/max, 0..1 percentile). Defaults to the band for the venue's capacity. Returns how many acts fall inside the band. If fewer than 6 fit, call again with a wider band; if the band is crowded for a small room, you may lower popularity_max. Give a reason whenever you change the band.",
    parameters: {
      type: "object",
      properties: {
        popularity_min: { type: "number", description: "Lower popularity bound 0..1 (default: capacity band)" },
        popularity_max: { type: "number", description: "Upper popularity bound 0..1 (default: capacity band)" },
        take: { type: "number", description: "How many candidates (5-15). Default 10." },
        reason: { type: "string", description: "Why you chose this band (required when it differs from the default)" },
      },
    },
  },
  {
    name: "audience_heatmap",
    label: "Map local affinity",
    description:
      "Get a geographic heatmap of taste affinity in the venue's city for the given artists (Qloo insights, filter.type=urn:heatmap). Defaults to the top 3 acts that fit the room.",
    parameters: {
      type: "object",
      properties: { artist_names: { type: "array", items: { type: "string" }, description: "Candidate names to map (optional)" } },
    },
  },
  {
    name: "audience_demographics",
    label: "Profile the audience",
    description: "Get age and gender skew of fans for the given artists (Qloo insights, filter.type=urn:demographics). Defaults to the top 3 acts that fit the room.",
    parameters: {
      type: "object",
      properties: { artist_names: { type: "array", items: { type: "string" }, description: "Candidate names (optional)" } },
    },
  },
  {
    name: "sponsor_brands",
    label: "Shortlist sponsor brands",
    description:
      "Find brands with high affinity among fans of the headliners and the top candidates (Qloo insights, filter.type=urn:entity:brand). The venue's city is sent as a location signal; the result says whether Qloo applied it.",
    parameters: { type: "object", properties: { take: { type: "number", description: "How many brands (3-10). Default 8." } } },
  },
  {
    name: "partner_places",
    label: "Find local partner spots",
    description:
      "Find nearby places (bars, record stores, restaurants) this crowd loves, for pre-show and after-party partnerships (Qloo insights, filter.type=urn:entity:place).",
    parameters: { type: "object", properties: { take: { type: "number", description: "How many places (3-8). Default 6." } } },
  },
  {
    name: "write_pitch",
    label: "Draft booking pitch",
    description:
      "Finish by writing the one-page booking pitch. Only cite facts returned by earlier tools. Prefer acts whose draw_fit is 'fits' (in this room's tier); call others 'stretch picks'. Do not state causation, claims about individuals, or outcomes (attendance, sales, sell-outs, guarantees). Only say local taste is concentrated near the venue if near_venue_lift > 1.1. The draft is checked against the data and replaced by a template if it overclaims.",
    parameters: {
      type: "object",
      properties: {
        headline: { type: "string", description: "One-line pitch headline" },
        summary: { type: "string", description: "2-3 sentence summary for the talent buyer" },
        pick_rationales: {
          type: "array",
          description: "Why each of the top 3 acts fits, citing affinity, draw fit and shared tags",
          items: {
            type: "object",
            properties: {
              artist: { type: "string", description: "Artist name" },
              why: { type: "string", description: "One or two sentences" },
            },
          },
        },
        sponsor_angle: { type: "string", description: "How to pitch the top sponsor brands, 1-2 sentences" },
      },
      required: ["headline", "summary", "pick_rationales", "sponsor_angle"],
    },
  },
];

/** Labels for every tool, including locate_city which runs before the LLM loop. */
export const TOOL_LABELS: Record<string, string> = {
  ...Object.fromEntries(TOOL_SPECS.map((t) => [t.name, t.label])),
  locate_city: "Locate the city",
};

const pct = (x: number) => Math.round(x * 100);
const srcs = (...r: QlooResult[]) => ({ sources: r.map((x) => x.source), endpoints: r.map((x) => x.endpoint) });
const norm = (s: string) => s.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();

function seedIds(ws: Workspace): string[] {
  if (ws.pending.length)
    throw new Error(`Headliners still ambiguous: ${ws.pending.map((p) => p.query).join(", ")}. Call resolve_headliner first.`);
  if (!ws.seeds.length) throw new Error("No headliners resolved yet. Call search_artist first.");
  return ws.seeds.map((s) => s.entityId);
}

/** Acts in the query band at or below the room's ceiling (in tier, or under-draw after widening). */
export function bookableCount(picks: ArtistPick[], used: PopBand, target: PopBand): number {
  return picks.filter((p) => p.popularity !== undefined && p.popularity >= used.min && p.popularity <= target.max).length;
}

/** Acts that fit the room first, then by affinity. Used for defaults and the pitch. */
export function bookableFirst(picks: ArtistPick[]): ArtistPick[] {
  const rank = (p: ArtistPick) => (p.drawFit === "fits" ? 0 : p.drawFit === "unknown" ? 1 : 2);
  return [...picks].sort((a, b) => rank(a) - rank(b) || b.affinity - a.affinity);
}

function pickIds(ws: Workspace, names: unknown): { ids: string[]; names: string[] } {
  let chosen = bookableFirst(ws.picks).slice(0, 3);
  if (Array.isArray(names) && names.length) {
    const wanted = names.map((n) => String(n).toLowerCase());
    const found = ws.picks.filter((p) => wanted.includes(p.name.toLowerCase()));
    if (found.length) chosen = found.slice(0, 5);
  }
  if (!chosen.length) throw new Error("No candidates yet. Call recommend_artists first.");
  return { ids: chosen.map((p) => p.entityId), names: chosen.map((p) => p.name) };
}

function clampInt(v: unknown, def: number, min: number, max: number) {
  const n = typeof v === "number" ? Math.round(v) : def;
  return Math.min(max, Math.max(min, n));
}

function unit(v: unknown, def: number) {
  const n = typeof v === "number" && isFinite(v) ? v : def;
  return Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
}

/** Search hits that plausibly refer to the query (same name, or one name contains the other). */
export function plausible(query: string, hits: RawEntity[]): RawEntity[] {
  const q = norm(query);
  const artists = hits.filter((h) => h.types.includes("urn:entity:artist") || !h.types.length);
  return artists.filter((h) => {
    const n = norm(h.name);
    return n === q || (n.length > 1 && q.includes(n)) || (q.length > 1 && n.includes(q));
  });
}

function toCandidate(h: RawEntity): PendingChoice["candidates"][number] {
  const description = h.description ?? (h.disambiguation && h.disambiguation !== h.name ? h.disambiguation : undefined);
  return { entityId: h.entityId, name: h.name, popularity: h.popularity, description, tags: h.tags.map((t) => t.name) };
}

/**
 * Insights call with signal.location.query. The Entity Type Parameter Guide
 * (https://docs.qloo.com/reference/available-parameters-by-entity-type) does not
 * list signal.location* for artist or brand, and Qloo silently ignores
 * unsupported params, so we report whether Qloo echoed a matched locality
 * instead of assuming the results are local. A 400 (no locality matched) is
 * retried once without the location.
 */
async function insightsNearVenue(params: Record<string, string | number | undefined>, loc: string, ctx: QlooCtx) {
  try {
    const r = await qloo.insights({ ...params, "signal.location.query": loc }, ctx);
    return { r, locality: matchedLocality(r.data), dropped: false };
  } catch (e) {
    if (!(e instanceof QlooError) || e.status !== 400) throw e;
    const r = await qloo.insights(params, ctx);
    return { r, locality: undefined, dropped: true };
  }
}

/**
 * Runs a Qloo call for an optional section. A 403 means the key does not include
 * this entity type (docs: "403 = entity type not enabled"); the section is marked
 * unavailable instead of failing the run.
 */
async function optional<T>(section: UnavailableSection, ws: Workspace, call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof QlooError && e.status === 403) {
      if (!ws.unavailable.includes(section)) ws.unavailable = [...ws.unavailable, section];
      return null;
    }
    throw e;
  }
}

function unavailableOutcome(what: string, filterType: string, consequence: string, simulated = false): ToolOutcome {
  return {
    summary: `Unavailable on hackathon key: Qloo returned 403 for ${filterType}${simulated ? " (simulated in recorded mode)" : ""}. ${consequence}`,
    forModel: JSON.stringify({ unavailable: true, reason: `Qloo returned 403 (${filterType} not enabled for this key)`, next: `Do not retry ${what}; continue without it.` }),
    sources: [],
    endpoints: [`GET /v2/insights (${filterType})`],
    unavailable: true,
  };
}

/** Maps Qloo explainability entity ids to the resolved headliner names. */
function drivers(list: { entityId: string; score: number }[] | undefined, ws: Workspace): Driver[] | undefined {
  if (!list?.length) return undefined;
  const names = new Map(ws.seeds.map((s) => [s.entityId, s.name]));
  const out = list.filter((x) => names.has(x.entityId)).map((x) => ({ entityId: x.entityId, name: names.get(x.entityId)!, score: x.score }));
  return out.length ? out : undefined;
}

/** "Moodymann 62%, Floating Points 38%" (scores are 0..1 normalised influence). */
export function driverText(d: Driver[] | undefined, max = 3): string {
  return (d ?? []).slice(0, max).map((x) => `${x.name} ${Math.round(x.score * 100)}%`).join(", ");
}

const locNote = (x: { locality?: string; dropped: boolean }, loc: string) =>
  x.locality ? `localised to ${x.locality}` : x.dropped ? `Qloo matched no locality for "${loc}", taste-wide` : "taste-wide, no locality applied";

/**
 * Deterministic disambiguation used by the scripted planner (the LLM decides on
 * its own). Score: exact name match, then overlap with the venue's genre tags
 * and genre phrase, then popularity as a tiebreak.
 */
export function chooseCandidate(ws: Workspace, choice: PendingChoice): { entityId: string; reason: string } {
  const genreWords = new Set(
    [...ws.genreTags.map((t) => t.name), ws.venue.genreHint].flatMap((s) => s.toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length > 2),
  );
  const genreNames = new Set(ws.genreTags.map((t) => t.name.toLowerCase()));
  const scored = choice.candidates.map((c) => {
    const exact = norm(c.name) === norm(choice.query);
    const overlap = c.tags.filter((t) => genreNames.has(t.toLowerCase()) || t.toLowerCase().split(/[^a-z0-9]+/).some((w) => genreWords.has(w)));
    return { c, exact, overlap, score: (exact ? 3 : 0) + overlap.length + (c.popularity ?? 0) * 0.5 };
  });
  scored.sort((a, b) => b.score - a.score);
  const [best, ...rest] = scored;
  const others = rest.map((r) => `${r.c.name}${r.c.description ? ` (${r.c.description})` : ""}`).join("; ");
  const why = [
    best.exact && !rest.some((r) => r.exact) ? "exact name match" : null,
    best.overlap.length ? `shares ${best.overlap.slice(0, 3).join(", ")} with the venue's genre` : null,
  ].filter(Boolean);
  return {
    entityId: best.c.entityId,
    reason: `${choice.candidates.length} Qloo artists match "${choice.query}". Chose ${best.c.name}${best.c.description ? ` (${best.c.description})` : ""}: ${why.join(" and ") || "highest popularity"}. Rejected: ${others}.`,
  };
}

export async function runTool(name: string, args: Args, ws: Workspace): Promise<ToolOutcome> {
  const loc = ws.venue.locationQuery;
  const sim = ws.venue.simulate;
  const ctx: QlooCtx = {
    fixtureSet: ws.venue.fixtureSet,
    simulateDenied: sim === "403" ? ["urn:demographics", "urn:tag"] : undefined,
    simulateNoExplain: sim === "no-explain",
  };
  switch (name) {
    case "locate_city": {
      const r = await qloo.search(loc, "urn:entity:locality", 3, ctx);
      const hit = parseSearch(r.data).find((h) => h.lat !== undefined && h.lng !== undefined);
      if (!hit) return { summary: `Qloo found no locality for "${loc}"; the map will centre on the data`, forModel: "No locality found.", ...srcs(r) };
      ws.venue = { ...ws.venue, lat: hit.lat!, lng: hit.lng!, needsGeocode: false, city: ws.venue.city || hit.name };
      return { summary: `"${loc}" -> ${hit.name} (${hit.lat!.toFixed(3)}, ${hit.lng!.toFixed(3)})`, forModel: JSON.stringify({ locality: hit.name }), ...srcs(r) };
    }

    case "search_artist": {
      const q = String(args.name ?? "").trim();
      if (!q) throw new Error("name is required");
      const r = await qloo.search(q, "urn:entity:artist", 5, ctx);
      const hits = parseSearch(r.data);
      let cands = plausible(q, hits);
      if (!cands.length) cands = hits.filter((h) => h.types.includes("urn:entity:artist")).slice(0, 3);
      if (!cands.length) return { summary: `No Qloo artist for "${q}"`, forModel: `No match for ${q}. Continue without it.`, ...srcs(r) };
      if (cands.length === 1) {
        const hit = cands[0];
        ws.seeds = [...ws.seeds.filter((s) => s.entityId !== hit.entityId), { query: q, entityId: hit.entityId, name: hit.name, popularity: hit.popularity, imageUrl: hit.imageUrl }];
        return {
          summary: `"${q}" -> ${hit.name}`,
          forModel: JSON.stringify({ resolved: hit.name, entity_id: hit.entityId, popularity: hit.popularity }),
          ...srcs(r),
        };
      }
      const choice: PendingChoice = { query: q, candidates: cands.slice(0, 4).map(toCandidate) };
      ws.pending = [...ws.pending.filter((p) => p.query.toLowerCase() !== q.toLowerCase()), choice];
      return {
        summary: `"${q}" is ambiguous: ${choice.candidates.map((c) => c.name + (c.description ? ` (${c.description})` : "")).join(" vs ")}`,
        forModel: JSON.stringify({
          ambiguous: true,
          query: q,
          candidates: choice.candidates.map((c) => ({ entity_id: c.entityId, name: c.name, description: c.description, tags: c.tags, popularity: c.popularity })),
          next: "Call resolve_headliner with the entity_id that matches this venue.",
        }),
        ...srcs(r),
      };
    }

    case "resolve_headliner": {
      const q = String(args.query ?? "").trim().toLowerCase();
      const choice = ws.pending.find((p) => p.query.toLowerCase() === q) ?? (ws.pending.length === 1 ? ws.pending[0] : undefined);
      if (!choice) throw new Error(`No ambiguous headliner called "${args.query}".`);
      const c = choice.candidates.find((x) => x.entityId === String(args.entity_id ?? ""));
      if (!c) throw new Error(`entity_id is not one of the candidates for "${choice.query}".`);
      const reason = String(args.reason ?? "").slice(0, 400) || "No reason given.";
      ws.pending = ws.pending.filter((p) => p !== choice);
      ws.seeds = [...ws.seeds.filter((s) => s.entityId !== c.entityId), { query: choice.query, entityId: c.entityId, name: c.name, popularity: c.popularity }];
      return {
        summary: `"${choice.query}" -> ${c.name}${c.description ? ` (${c.description})` : ""}`,
        forModel: JSON.stringify({ resolved: c.name, entity_id: c.entityId }),
        sources: [],
        endpoints: [],
        decisions: [{ title: `"${choice.query}" = ${c.name}${c.description ? `, ${c.description.split(/[.;]/)[0].slice(0, 60)}` : ""}`, detail: reason }],
      };
    }

    case "find_genre_tags": {
      const q = String(args.query ?? ws.venue.genreHint);
      let r = await qloo.tags(q, 5, ctx);
      // Fall back to any tag type if the music-genre namespace has no match.
      if (!parseTagList(r.data).length) r = await qloo.tags(q, 5, ctx, undefined);
      // /v2/tags is a fuzzy search ("deep house" also returns "Deephouse", "Deep Progressive
      // House"): keep exact name matches (ignoring spaces and punctuation), else the top hit.
      const key = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const found = parseTagList(r.data);
      const exact = found.filter((t) => key(t.name) === key(q));
      const tags = (exact.length ? exact : found).slice(0, 1);
      ws.genreTags = tags;
      return {
        summary: tags.length ? `"${q}" -> ${tags.map((t) => `${t.name} (${t.id})`).join(", ")}` : `No tags for "${q}"`,
        forModel: JSON.stringify(tags.map((t) => ({ id: t.id, name: t.name }))),
        ...srcs(r),
      };
    }

    case "taste_profile": {
      const ids = seedIds(ws);
      const r = await optional("taste_profile", ws, () => qloo.insights(
        {
          "filter.type": "urn:tag",
          "filter.parents.types": "urn:entity:artist",
          // Genre tags only, so they line up with artist tags (type urn:tag:genre:music).
          "filter.tag.types": "urn:tag:genre:music",
          "signal.interests.entities": ids.join(","),
          take: 10,
        },
        ctx,
      ));
      if (!r) return unavailableOutcome("taste_profile", "urn:tag", "Acts are ranked without the shared-tag check.", sim === "403");
      ws.tasteTags = parseTagList(r.data);
      return {
        summary: `Top tags: ${ws.tasteTags.slice(0, 4).map((t) => t.name).join(", ")}`,
        forModel: JSON.stringify(ws.tasteTags.map((t) => ({ name: t.name, affinity: t.affinity }))),
        ...srcs(r),
      };
    }

    case "recommend_artists": {
      const take = clampInt(args.take, DEFAULT_TAKE, 5, 15);
      const seeds = seedIds(ws);
      const target = ws.band?.target ?? capacityBand(ws.venue.capacity);
      const dflt = searchBand(ws.venue.capacity);
      let used: PopBand = { min: unit(args.popularity_min, dflt.min), max: unit(args.popularity_max, dflt.max) };
      if (used.max - used.min < MIN_BAND_WIDTH) used = dflt;
      const near = await insightsNearVenue(
        {
          "filter.type": "urn:entity:artist",
          "signal.interests.entities": seeds.join(","),
          // No signal.interests.tags: measured live on 2026-10-06, a tag signal adds 13-30 s
          // to a cold call (25.3 s vs 0.7 s) and barely changes the ranking. Genre tags are
          // used for disambiguation and the shared-tag check instead.
          "filter.exclude.entities": seeds.join(","),
          "filter.popularity.min": used.min,
          "filter.popularity.max": used.max,
          // Which input headliner drove each pick (normalised 0..1 per seed).
          "feature.explainability": "true",
          take,
        },
        loc,
        ctx,
      );
      const r = near.r;
      // Match on tag id (both use urn:tag:genre:music:*) or on the cleaned name.
      const tasteIds = new Set(ws.tasteTags.map((t) => t.id));
      const tasteNames = new Set(ws.tasteTags.map((t) => t.name.toLowerCase()));
      const all: ArtistPick[] = parseEntities(r.data)
        .filter((e) => !seeds.includes(e.entityId))
        .map((e) => ({
          entityId: e.entityId,
          name: e.name,
          affinity: e.affinity ?? 0,
          popularity: e.popularity,
          imageUrl: e.imageUrl,
          shortDescription: e.description,
          tags: e.tags,
          sharedTags: dedupeNames(e.tags.filter((t) => tasteIds.has(t.id) || tasteNames.has(t.name.toLowerCase())).map((t) => t.name)),
          drawFit: drawFit(e.popularity, target),
          drivenBy: seeds.length > 1 ? drivers(e.explain, ws) : undefined,
        }));
      let picks = bookableFirst(all).slice(0, take);
      const prev = ws.band ? { picks: ws.picks, band: ws.band, explain: ws.explain } : undefined;
      // Capping the top drops stretch acts; keep the two strongest as labelled reach options.
      if (prev && used.max < prev.band.used.max) {
        const have = new Set(picks.map((p) => p.entityId));
        const carry = prev.picks
          .filter((p) => p.drawFit === "stretch" && !have.has(p.entityId))
          .sort((a, b) => b.affinity - a.affinity)
          .slice(0, 2);
        picks = [...picks, ...carry];
      }
      const changed = !!prev && (used.min !== prev.band.used.min || used.max !== prev.band.used.max);
      const agg = parseExplainSummary(r.data);
      const aggDrivers = seeds.length > 1 ? drivers(agg?.drivers, ws) : undefined;

      // A re-query only counts as a decision if it changes the shortlist (at least 2 new acts).
      let decisions: ToolOutcome["decisions"];
      let reverted = false;
      if (prev && changed) {
        const before = new Set(prev.picks.map((p) => p.entityId));
        const after = new Set(picks.map((p) => p.entityId));
        const added = picks.filter((p) => !before.has(p.entityId));
        const dropped = prev.picks.filter((p) => !after.has(p.entityId));
        const top3 = (l: ArtistPick[]) => bookableFirst(l).slice(0, 3).map((p) => p.name).join(", ");
        if (added.length < 2) {
          reverted = true;
          decisions = [
            {
              title: `Kept the first shortlist: a re-search added only ${added.length} new act${added.length === 1 ? "" : "s"}`,
              detail: `Re-querying ${bandLabel(used)} added only ${added.length} new act${added.length === 1 ? "" : "s"} to the shortlist, so the earlier results stand.`,
            },
          ];
        } else {
          const why = typeof args.reason === "string" && args.reason.trim() ? String(args.reason).slice(0, 400) : "Band changed by the planner.";
          decisions = [
            {
              title: used.max < prev.band.used.max ? "Searched smaller acts to fit the room better" : "Widened the search to find more acts that fit",
              detail: `${why} Result: ${added.length} new acts (${added.slice(0, 4).map((p) => p.name).join(", ")})${dropped.length ? `, dropped ${dropped.slice(0, 4).map((p) => p.name).join(", ")}` : ""}. Top 3 before: ${top3(prev.picks)}; after: ${top3(picks)}.`,
            },
          ];
        }
      }
      if (reverted && prev) {
        ws.picks = prev.picks;
        ws.explain = prev.explain;
        ws.band = { ...prev.band, history: [...prev.band.history, `${bandLabel(used)}: reverted (shortlist barely changed)`] };
      } else {
        ws.picks = picks;
        ws.explain = agg && aggDrivers ? { subset: agg.subset, drivers: aggDrivers } : undefined;
      }
      const cur = ws.picks;
      const curBand = reverted && prev ? prev.band.used : used;
      const inTier = cur.filter((p) => p.drawFit === "fits").length;
      const stretch = cur.filter((p) => p.drawFit === "stretch").length;
      if (!reverted) ws.band = { target, used, history: [...(ws.band?.history ?? []), `${bandLabel(used)}: ${inTier} in tier, ${stretch} stretch`] };
      const explained = cur.filter((p) => p.drivenBy?.length).length;
      const advice =
        inTier < MIN_FIT && stretch > 0 && curBand.max > target.max
          ? `Only ${inTier} acts are inside the room's tier ${bandLabel(target)}; ${stretch} are stretch picks. Cap popularity_max at ${target.max} and call recommend_artists again to surface more acts the room can book.`
          : bookableCount(cur, curBand, target) < MIN_FIT
            ? `Only ${bookableCount(cur, curBand, target)} acts are at or below the room's ceiling. Widen downwards (popularity_min about ${Math.max(0, Math.round((curBand.min - 0.06) * 1000) / 1000)}) and call recommend_artists again.`
            : "Enough acts fit the room; no re-query needed.";
      return {
        summary: `${reverted ? `Re-query ${bandLabel(used)} barely changed the list; kept ${bandLabel(curBand)}` : `Band ${bandLabel(used)}`} (room tier ${bandLabel(target)}), ${locNote(near, loc)}: ${inTier} in tier, ${stretch} stretch; top: ${bookableFirst(cur)
          .slice(0, 3)
          .map((p) => `${p.name} ${pct(p.affinity)}`)
          .join(", ")}${explained ? `; explainability on ${explained}/${cur.length}${ws.explain ? `, ${ws.explain.subset} driven by ${driverText(ws.explain.drivers)}` : ""}` : ""}`,
        forModel: JSON.stringify({
          capacity: ws.venue.capacity,
          room_tier_band: target,
          query_band: used,
          reverted: reverted || undefined,
          returned: cur.length,
          in_tier: inTier,
          stretch,
          location: locNote(near, loc),
          advice,
          explainability_note: "driven_by = Qloo feature.explainability: share of each past headliner's influence on the pick (0..1). Cite it in pick_rationales when present.",
          headliner_influence: ws.explain ? { subset: ws.explain.subset, drivers: ws.explain.drivers.map((d) => ({ headliner: d.name, avg_score: d.score })) } : undefined,
          acts: cur.map((p) => ({
            name: p.name,
            affinity: p.affinity,
            popularity: p.popularity,
            draw_fit: p.drawFit,
            shared_tags: p.sharedTags,
            driven_by: p.drivenBy?.map((d) => ({ headliner: d.name, score: d.score })),
          })),
        }),
        decisions,
        ...srcs(r),
      };
    }

    case "audience_heatmap": {
      const { ids, names } = pickIds(ws, args.artist_names);
      const r = await qloo.insights({ "filter.type": "urn:heatmap", "signal.interests.entities": ids.join(","), "filter.location.query": loc }, ctx);
      ws.heatmap = parseHeatmap(r.data);
      // Recorded mode may replay a heatmap recorded for other acts: name those, not the request.
      const mapped = r.standIn?.names ?? names;
      ws.heatmapSubject = mapped;
      const hs = hotspots(ws);
      return {
        summary: `${ws.heatmap.length} map cells for ${mapped.join(", ")}${r.standIn ? ` (recorded mode: the closest recorded call, not ${names.join(", ")})` : ""}${hs ? `; ${hs.hotPct}% of the hottest fifth of cells are within ${HOT_KM} km of ${anchor(ws)} vs ${hs.allPct}% of all cells (${hs.lift !== undefined ? `${hs.lift.toFixed(2)}x: ${hs.concentrated ? "concentrated near the venue" : "spread across the city"}` : "no comparison"})` : ""}`,
        forModel: JSON.stringify({
          cells: ws.heatmap.length,
          hottest_fifth_within_2km_pct: hs?.hotPct,
          all_cells_within_2km_pct: hs?.allPct,
          near_venue_lift: hs?.lift,
          ...(r.standIn ? { note: `Recorded data: this heatmap was recorded for ${mapped.join(", ")}, not the requested acts.` } : {}),
          reading: hs ? (hs.concentrated ? "Hot cells are concentrated near the venue." : "Taste is spread across the city, not concentrated near the venue. Do not claim strong local affinity.") : "No comparison possible.",
          mapped,
        }),
        ...srcs(r),
      };
    }

    case "audience_demographics": {
      const { ids } = pickIds(ws, args.artist_names);
      const r = await optional("demographics", ws, () => qloo.insights({ "filter.type": "urn:demographics", "signal.interests.entities": ids.join(",") }, ctx));
      if (!r) return unavailableOutcome("audience_demographics", "urn:demographics", "The audience section shows a note instead of age and gender skew.", sim === "403");
      const names = new Map(ws.picks.map((p) => [p.entityId, p.name]));
      r.standIn?.ids.forEach((id, i) => names.set(id, r.standIn!.names[i]));
      ws.demographics = parseDemographics(r.data, names);
      const top = ws.demographics.map((d) => `${d.name}: ${topBucket(d.age)}`);
      return {
        summary: top.length ? `Strongest age skew: ${top.join("; ")}${r.standIn ? " (recorded mode: the closest recorded call)" : ""}` : "No demographic data returned",
        forModel: JSON.stringify(ws.demographics.map((d) => ({ artist: d.name, age_skew: d.age, gender_skew: d.gender }))),
        ...srcs(r),
      };
    }

    case "sponsor_brands": {
      const take = clampInt(args.take, 8, 3, 10);
      const ids = [...seedIds(ws), ...bookableFirst(ws.picks).slice(0, 3).map((p) => p.entityId)];
      const near = await insightsNearVenue({ "filter.type": "urn:entity:brand", "signal.interests.entities": ids.join(","), take }, loc, ctx);
      const r = near.r;
      ws.brands = parseEntities(r.data).map(toBrand).sort((a, b) => b.affinity - a.affinity).slice(0, take);
      ws.brandsLocality = near.locality;
      return {
        summary: `${ws.brands.length} brands (${locNote(near, loc)}); top: ${ws.brands.slice(0, 3).map((b) => b.name).join(", ")}${r.standIn ? ` (recorded mode: recorded for ${r.standIn.names.join(", ")})` : ""}`,
        forModel: JSON.stringify(ws.brands.map((b) => ({ name: b.name, affinity: b.affinity, category: b.category }))),
        ...srcs(r),
      };
    }

    case "partner_places": {
      const take = clampInt(args.take, 6, 3, 8);
      // Over-fetch, then keep music-relevant spots (bars, venues, record stores, cafes, galleries).
      const r = await qloo.insights(
        { "filter.type": "urn:entity:place", "signal.interests.entities": seedIds(ws).join(","), "filter.location.query": loc, take: take * 3 },
        ctx,
      );
      const { keep, dropped } = relevantPlaces(parseEntities(r.data));
      ws.places = keep.sort((a, b) => b.affinity - a.affinity).slice(0, take);
      return {
        summary: `${ws.places.length} music-relevant places${matchedLocality(r.data) ? ` in ${matchedLocality(r.data)}` : ""}${dropped.length ? ` (dropped ${dropped.length} off-theme: ${dropped.slice(0, 3).join(", ")})` : ""}; top: ${ws.places.slice(0, 3).map((p) => p.name).join(", ")}`,
        forModel: JSON.stringify(ws.places.map((p) => ({ name: p.name, affinity: p.affinity, category: p.category }))),
        ...srcs(r),
      };
    }

    case "write_pitch": {
      if (!ws.picks.length) throw new Error("No candidates yet. Call recommend_artists first.");
      const rationales = Array.isArray(args.pick_rationales)
        ? (args.pick_rationales as { artist?: unknown; why?: unknown }[])
            .map((p) => ({ artist: String(p?.artist ?? ""), why: String(p?.why ?? "") }))
            .filter((p) => p.artist && p.why)
            .slice(0, 5)
        : [];
      const t = templatePitch(ws);
      const draft: Pitch = {
        headline: String(args.headline ?? "").slice(0, 200) || t.headline,
        summary: String(args.summary ?? "").slice(0, 1200) || t.summary,
        pickRationales: rationales.length ? rationales : t.pickRationales,
        sponsorAngle: String(args.sponsor_angle ?? "").slice(0, 600) || t.sponsorAngle,
        author: args.__template ? "template" : "llm",
      };
      if (draft.author === "llm") Object.assign(draft, tidyPitch(draft, ws));
      const problems = draft.author === "llm" ? pitchProblems(draft, ws) : [];
      if (problems.length) {
        ws.pitch = { ...t, checkNote: `The LLM's pitch was replaced by the template because it made claims the Qloo data does not support: ${problems.join("; ")}.` };
        return {
          summary: `LLM pitch failed the data check (${problems.join("; ")}); used the template pitch`,
          forModel: "Pitch saved (template, because the draft made unsupported claims). You are done.",
          sources: [],
          endpoints: [],
          decisions: [{ title: "Rejected the LLM pitch draft", detail: `Post-check against the Qloo results found: ${problems.join("; ")}. Used the data-only template pitch instead.` }],
        };
      }
      ws.pitch = draft;
      return { summary: `Pitch drafted: "${draft.headline}"`, forModel: "Pitch saved. You are done.", sources: [], endpoints: [] };
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ---- helpers ----

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Drops near-duplicate tag names ("Hip - Hop" vs "Hip Hop"), keeping the first. */
function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => {
    const k = n.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const HOT_KM = 2;

// Outcome promises the data cannot back (affinity is correlation; we do not forecast sales).
const OUTCOME_CLAIM =
  /\bguarantee|\bsell[- ]?outs?\b|\bsold[- ]?out\b|\bsells? out\b|\bpacked\b|\bsure[- ]?fire\b|\bwill (?:sell|fill|pack|draw)\b|\bticket sales\b|\battendance\b|\brevenue\b|\bbox office\b/i;
// Claims that the crowd is concentrated around the venue.
const LOCAL_CLAIM =
  /\b(?:strong|high|deep|dense|concentrated|robust|significant)\s+(?:local|neighbou?rhood|nearby)\b|\blocal\s+(?:audience\s+)?(?:affinity|demand|fan\s?base|following|taste)\s+(?:is\s+)?(?:strong|high|concentrated)|\bconcentrated (?:near|around)\b|\bon (?:your|the venue's) doorstep\b/i;
const IN_TIER_CLAIM = /\bfits? the room\b|\bin (?:this|the) room's tier\b|\bin[- ]tier\b|\bright[- ]sized\b|\bright size\b|\bsized for the room\b/i;

/** Claims in an LLM pitch that the workspace data does not support (empty = passes). */
export function pitchProblems(p: Pitch, ws: Workspace): string[] {
  const all = [p.headline, p.summary, p.sponsorAngle, ...p.pickRationales.map((r) => r.why)].join(" \n ");
  const out: string[] = [];
  const outcome = all.match(OUTCOME_CLAIM);
  if (outcome) out.push(`promises an outcome ("${outcome[0]}")`);
  const hs = hotspots(ws);
  const local = all.match(LOCAL_CLAIM);
  if (local && !hs?.concentrated)
    out.push(`claims local concentration ("${local[0]}") but the heatmap lift is ${hs?.lift !== undefined ? `${hs.lift.toFixed(2)}x` : "unknown"} (needs > ${NEAR_LIFT_MIN})`);
  for (const r of p.pickRationales) {
    const act = ws.picks.find((x) => norm(x.name) === norm(r.artist));
    if (act && act.drawFit !== "fits" && IN_TIER_CLAIM.test(r.why)) out.push(`calls ${act.name} a fit for the room, but it is ${FIT_WORDS[act.drawFit ?? "unknown"]}`);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const RAW_NUM = String.raw`(?:0?\.\d+|\d{1,3}/100)`;
const toPct = (n: string) => (n.includes("/") ? `${parseInt(n, 10)}%` : `${Math.round(parseFloat(n) * 100)}%`);

/**
 * Takes raw Qloo scores out of pitch prose: "(0.348)" after a past headliner becomes
 * "(35%)" (its share of the pull), other bracketed scores and "affinity 0.97" style
 * numbers are dropped, and any leftover 0.xx decimal is written as a percent.
 */
export function scrubNumbers(text: string, seedNames: string[]): string {
  const seeds = seedNames.map((n) => n.toLowerCase());
  const bracketed = new RegExp(String.raw`\s*\(\s*(?:[A-Za-z][A-Za-z ]*:?\s*)?(${RAW_NUM})\s*\)`, "g");
  return text
    .replace(bracketed, (_m: string, n: string, at: number, all: string) => {
      const before = all.slice(0, at).toLowerCase().trimEnd();
      return seeds.some((s) => before.endsWith(s)) ? ` (${toPct(n)})` : "";
    })
    .replace(new RegExp(String.raw`\b(affinity|popularity|score)(?:\s+(?:of|at|is|score of))?:?\s+${RAW_NUM}(?![\d.])`, "gi"), "$1")
    .replace(new RegExp(String.raw`(?<![\w.])${RAW_NUM}\s+(affinity|popularity|score)\b`, "gi"), "$1")
    .replace(/(?<![\w.])0?\.\d{2,}(?!\d)/g, (n) => toPct(n))
    .replace(/\ba (affinity)\b/gi, "an $1")
    .replace(/ {2,}/g, " ")
    .replace(/ +([,.;:])/g, "$1");
}

/**
 * Fixes an LLM pitch in place of rejecting it: act and headliner names in Qloo's
 * canonical spelling ("sasami" -> "SASAMI"), custom venues (placed at the city
 * centre, no street address) never described as "near the venue", and raw score
 * decimals rewritten in words or percents (scrubNumbers).
 */
export function tidyPitch(p: Pitch, ws: Workspace): Pick<Pitch, "headline" | "summary" | "sponsorAngle" | "pickRationales"> {
  const names = [...ws.picks.map((x) => x.name), ...ws.seeds.map((s) => s.name)].filter((n) => n.length > 2).sort((a, b) => b.length - a.length);
  const fix = (s: string) => {
    let out = s;
    for (const n of names) out = out.replace(new RegExp(`(?<![\\w])${escapeRe(n)}(?![\\w])`, "gi"), n);
    if (ws.venue.custom) out = out.replace(/\b(near|around|close to|by|next to) (?:the|your) venue\b/gi, "$1 the city centre");
    out = scrubNumbers(out, ws.seeds.map((x) => x.name));
    // Ranks live on the cards only, so the pitch can't contradict them ("the #2 match" vs a "#3" card).
    out = out.replace(/\b(the\s+)?#\d+\s+(?:taste\s+)?match(?:\s+of\s+\d+)?(?:\s*\((?:affinity|popularity)\))?(?:\s+with\s+(?:high\s+|strong\s+)?affinity)?/gi, (m) =>
      /^The\b/.test(m) ? "A top taste match" : "a top taste match",
    );
    return out
      .replace(/\s*\b[a-z]+_[a-z_]+\b(?:\s+score)?/g, "")
      .replace(/\s+\)/g, ")")
      .replace(/\s*\((?:affinity|popularity)\)/gi, "")
      .replace(/\b(?:at|with) (?:affinity|popularity),\s*(\w)/gi, (_m, c: string) => c.toUpperCase())
      .replace(/ {2,}/g, " ");
  };
  return {
    headline: fix(p.headline),
    summary: fix(p.summary),
    sponsorAngle: fix(p.sponsorAngle),
    pickRationales: p.pickRationales.map((r) => {
      const act = ws.picks.find((x) => norm(x.name) === norm(r.artist));
      return { artist: act?.name ?? r.artist, why: fix(r.why) };
    }),
  };
}

// Partner spots: keep places a music crowd would go before or after a show. Matched
// against Qloo place tags (urn:tag:genre:place), e.g. "Live music venue", "Cocktail bar".
const PLACE_KEEP =
  /\b(?:bar|pub|lounge|tavern|saloon|brewery|brewpub|taproom|winery|distillery|night ?club|dance club|music|jazz|club|record|vinyl|cafe|caf\u00e9|coffee|tea house|gallery|art|museum|cultural|theater|theatre|cinema|bookstore|book store|venue|concert|karaoke|beer|wine|cocktail)\b/i;
const PLACE_DROP =
  /\b(?:therap|psych|counsel|clinic|medical|dental|dentist|doctor|hospital|pharmacy|tattoo|piercing|personal care|salon|barber|spa|nail|hotel|motel|hostel|lodging|bank|insurance|real estate|lawyer|attorney|church|school|gym|fitness|golf|country club|auto|laundr|storage|mental health)/i;

/** True when Qloo's place tags say this is somewhere a music crowd might partner with. */
export function musicRelevantPlace(tags: string[]): boolean {
  const named = tags.filter((t) => t && t.toLowerCase() !== "place");
  if (!named.length) return false;
  if (named.some((t) => PLACE_DROP.test(t))) return false;
  return named.some((t) => PLACE_KEEP.test(t));
}

function placeCategory(tags: string[], fallback?: string): string | undefined {
  const skip = /^(place|tourist attraction|restaurant|shopping)$/i;
  return tags.find((t) => PLACE_KEEP.test(t) && !skip.test(t)) ?? fallback;
}

/** Filters Qloo place results to music-relevant spots; reports what was dropped. */
function relevantPlaces(ents: ReturnType<typeof parseEntities>): { keep: PlacePick[]; dropped: string[] } {
  const keep: PlacePick[] = [];
  const dropped: string[] = [];
  for (const e of ents) {
    const tags = e.tags.map((t) => t.name);
    if (musicRelevantPlace(tags)) keep.push({ ...toPlace(e), category: placeCategory(tags, toPlace(e).category) });
    else dropped.push(e.name);
  }
  return { keep, dropped };
}

/** Custom venues are placed at the city centre (no street address), so say so. */
const anchor = (ws: Workspace) => (ws.venue.custom ? "the city centre" : "the venue");

/**
 * Qloo heatmap affinity is rank-normalised (uniform 0..1) and the cells are clipped
 * to the city, so a raw "share of affinity near the venue" mostly measures how many
 * cells are near it (live Detroit: 85% of cells, 87% of affinity within 5 km).
 * Instead compare the hottest fifth of cells with all cells: if hot cells sit near
 * the venue more often than cells in general, the crowd is concentrated nearby.
 */
export function hotspots(ws: Workspace, km = HOT_KM): { hotPct: number; allPct: number; lift?: number; concentrated: boolean } | undefined {
  if (ws.venue.needsGeocode || ws.heatmap.length < 5) return undefined;
  const near = (p: { lat: number; lng: number }) => haversineKm(ws.venue.lat, ws.venue.lng, p.lat, p.lng) <= km;
  const hot = [...ws.heatmap].sort((a, b) => b.affinity - a.affinity).slice(0, Math.ceil(ws.heatmap.length / 5));
  const pctOf = (l: { lat: number; lng: number }[]) => Math.round((l.filter(near).length / l.length) * 100);
  const hotPct = pctOf(hot);
  const allPct = pctOf(ws.heatmap);
  // Same ratio and threshold as the UI (lib/ui.ts concentration).
  const lift = allPct > 0 ? Math.round((hotPct / allPct) * 100) / 100 : undefined;
  return { hotPct, allPct, lift, concentrated: lift !== undefined && lift > NEAR_LIFT_MIN };
}

export function topBucket(age: Record<string, number>): string {
  const e = Object.entries(age).sort((a, b) => b[1] - a[1])[0];
  // Demographic values are relative affinity scores (0 = average, + above, - below),
  // not percentages: https://docs.qloo.com/reference/demographics-use-case
  return e ? `${e[0].replace(/_/g, " ")} (${e[1] >= 0 ? "+" : ""}${e[1].toFixed(2)} vs. avg)` : "n/a";
}

// Same wording as the UI verdict chips (lib/ui.ts VERDICT).
const FIT_WORDS = { fits: "in this room's tier", stretch: "stretch pick", under: "below this room's tier", unknown: "tier unknown" } as const;

// Plain-English room fit for pitch text (the raw popularity stays in the UI tooltip and the .md table).
const SIZE_WORDS = { fits: "the right size for this room", stretch: "a stretch pick (bigger than this room's usual draw)", under: "smaller than this room's usual draw" } as const;

/** "#1 taste match of 10": rank by Qloo affinity among all candidates. */
export function tasteRankText(p: ArtistPick, all: ArtistPick[]): string {
  const rank = [...all].sort((a, b) => b.affinity - a.affinity).findIndex((x) => x.entityId === p.entityId) + 1;
  return rank > 0 ? `#${rank} taste match of ${all.length}` : "a strong taste match";
}

/** Deterministic pitch built only from Workspace facts (used by the scripted planner and as a fallback). */
export function templatePitch(ws: Workspace): Pitch {
  const top3 = bookableFirst(ws.picks).slice(0, 3);
  const a = top3[0];
  const hs = hotspots(ws);
  const brands = ws.brands.slice(0, 3).map((x) => x.name);
  const demo = ws.demographics.find((d) => d.entityId === a?.entityId) ?? ws.demographics[0];
  const cityShort = ws.venue.city.split(",")[0];
  return {
    headline: `${ws.venue.name}: ${a?.name ?? "The top pick"} is the strongest taste match${a?.drawFit === "fits" ? ", sized for the room," : ""} for your next ${cityShort} headline night`,
    summary:
      `Fans of ${ws.seeds.map((s) => s.name).join(", ")} show the highest Qloo affinity for ${top3.map((p) => p.name).join(", ")}` +
      (ws.band ? `, each checked against the ${bandLabel(ws.band.target)} popularity tier for a ${ws.venue.capacity}-capacity room (a heuristic for draw, not a ticket forecast). ` : ". ") +
      (hs
        ? hs.concentrated
          ? `Taste for ${ws.heatmapSubject.join(", ")} is concentrated near ${anchor(ws)}: ${hs.hotPct}% of the hottest fifth of Qloo's ${cityShort} map cells sit within ${HOT_KM} km, vs ${hs.allPct}% of all cells (${hs.lift!.toFixed(1)}x). `
          : `Qloo's ${cityShort} map shows taste for ${ws.heatmapSubject.join(", ")} spread across the city rather than concentrated near ${anchor(ws)}. `
        : "") +
      (ws.explain ? `Qloo explainability: across the ${ws.explain.subset} picks, the pull comes from ${driverText(ws.explain.drivers)}. ` : "") +
      (demo
        ? `${demo.name}'s crowd skews ${topBucket(demo.age)}.`
        : ws.unavailable.includes("demographics")
          ? "Audience age and gender data is not available on this Qloo key."
          : ""),
    pickRationales: top3.map((p) => ({
      artist: p.name,
      why:
        `${tasteRankText(p, ws.picks)}${p.drawFit && p.drawFit !== "unknown" ? `, ${SIZE_WORDS[p.drawFit]}` : ""}. ` +
        (p.sharedTags.length ? `Shares ${p.sharedTags.slice(0, 3).join(", ")} with the venue's taste profile.` : "Adjacent to the venue's taste profile.") +
        (p.drivenBy?.length ? ` Driven by ${driverText(p.drivenBy)} (Qloo explainability).` : ""),
    })),
    sponsorAngle: brands.length
      ? `Lead with ${brands.join(", ")}: these brands score highest with this crowd${ws.brandsLocality ? ` in ${cityShort}` : ""}. Offer co-branded nights with ${ws.places[0]?.name ?? "a local partner"} as the pre-show spot.`
      : "No sponsor data yet.",
    author: "template",
  };
}
