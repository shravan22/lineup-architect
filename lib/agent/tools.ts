import "server-only";
import { bandLabel, capacityBand, drawFit, inBand } from "@/lib/band";
import { qloo, QlooError, type QlooCtx, type QlooResult } from "@/lib/qloo/client";
import {
  parseDemographics,
  parseEntities,
  parseHeatmap,
  parseSearch,
  matchedLocality,
  parseTagList,
  toBrand,
  toPlace,
  type RawEntity,
} from "@/lib/qloo/normalize";
import type { ArtistPick, DataSource, PendingChoice, Pitch, PopBand, Workspace } from "@/lib/types";

// Agent tools. Each tool calls Qloo (or the labelled sample fixtures), writes
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
    description: "Find Qloo genre tag IDs for a genre phrase using Qloo /v2/tags. The tags are used as extra signal when recommending artists.",
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
      "Rank artists by Qloo affinity to the past headliners and genre tags (the venue's city is sent as a location signal; the result says whether Qloo applied it), restricted to a Qloo popularity band (filter.popularity.min/max, 0..1 percentile). Defaults to the band for the venue's capacity. Returns how many acts fall inside the band. If fewer than 6 fit, call again with a wider band; if the band is crowded for a small room, you may lower popularity_max. Give a reason whenever you change the band.",
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
      "Finish by writing the one-page booking pitch. Only cite facts returned by earlier tools. Prefer acts whose draw fit is 'fits'. Do not state causation or claims about individuals.",
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
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
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
  const ctx: QlooCtx = { fixtureSet: ws.venue.fixtureSet };
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
        decisions: [{ title: `Disambiguated "${choice.query}"`, detail: reason }],
      };
    }

    case "find_genre_tags": {
      const q = String(args.query ?? ws.venue.genreHint);
      let r = await qloo.tags(q, 5, ctx);
      // Fall back to any tag type if the music-genre namespace has no match.
      if (!parseTagList(r.data).length) r = await qloo.tags(q, 5, ctx, undefined);
      const tags = parseTagList(r.data).slice(0, 3);
      ws.genreTags = tags;
      return {
        summary: tags.length ? `${tags.length} tags: ${tags.map((t) => t.name).join(", ")}` : `No tags for "${q}"`,
        forModel: JSON.stringify(tags.map((t) => ({ id: t.id, name: t.name }))),
        ...srcs(r),
      };
    }

    case "taste_profile": {
      const r = await qloo.insights(
        {
          "filter.type": "urn:tag",
          "filter.parents.types": "urn:entity:artist",
          // Genre tags only, so they line up with artist tags (type urn:tag:genre:music).
          "filter.tag.types": "urn:tag:genre:music",
          "signal.interests.entities": seedIds(ws).join(","),
          take: 10,
        },
        ctx,
      );
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
      let used: PopBand = { min: unit(args.popularity_min, target.min), max: unit(args.popularity_max, target.max) };
      if (used.max - used.min < 0.1) used = target;
      const near = await insightsNearVenue(
        {
          "filter.type": "urn:entity:artist",
          "signal.interests.entities": seeds.join(","),
          "signal.interests.tags": ws.genreTags.map((t) => t.id).join(",") || undefined,
          "filter.exclude.entities": seeds.join(","),
          "filter.popularity.min": used.min,
          "filter.popularity.max": used.max,
          take,
        },
        loc,
        ctx,
      );
      const r = near.r;
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
          sharedTags: e.tags.filter((t) => tasteNames.has(t.name.toLowerCase())).map((t) => t.name),
          drawFit: drawFit(e.popularity, target),
        }));
      const picks = bookableFirst(all).slice(0, take);
      // Count against the queried band on our side too: Qloo silently ignores invalid params.
      const fitting = picks.filter((p) => inBand(p.popularity, used)).length;
      const changed = used.min !== target.min || used.max !== target.max;
      const prev = ws.band?.used ?? target;
      ws.picks = picks;
      ws.band = { target, used, history: [...(ws.band?.history ?? []), `${bandLabel(used)}: ${fitting} act${fitting === 1 ? "" : "s"}`] };
      const advice =
        fitting < MIN_FIT
          ? `Only ${fitting} acts are inside ${bandLabel(used)}. Widen the band (e.g. +/-0.08) and call recommend_artists again.`
          : picks.length >= take && ws.venue.capacity <= 400 && !changed
            ? "The band is crowded for a small room. Consider lowering popularity_max so fees stay bookable."
            : "Enough acts fit the room.";
      const decisions =
        changed && typeof args.reason === "string" && args.reason.trim()
          ? [{ title: `Popularity band ${bandLabel(prev)} -> ${bandLabel(used)}`, detail: String(args.reason).slice(0, 400) }]
          : undefined;
      return {
        summary: `Band ${bandLabel(used)}${changed ? ` (room target ${bandLabel(target)})` : ""}, ${locNote(near, loc)}: ${fitting} in band; top: ${picks
          .slice(0, 3)
          .map((p) => `${p.name} ${pct(p.affinity)}`)
          .join(", ")}`,
        forModel: JSON.stringify({
          capacity: ws.venue.capacity,
          target_band: target,
          query_band: used,
          returned: picks.length,
          in_band: fitting,
          location: locNote(near, loc),
          advice,
          acts: picks.map((p) => ({ name: p.name, affinity: p.affinity, popularity: p.popularity, draw_fit: p.drawFit, shared_tags: p.sharedTags })),
        }),
        decisions,
        ...srcs(r),
      };
    }

    case "audience_heatmap": {
      const { ids, names } = pickIds(ws, args.artist_names);
      const r = await qloo.insights({ "filter.type": "urn:heatmap", "signal.interests.entities": ids.join(","), "filter.location.query": loc }, ctx);
      ws.heatmap = parseHeatmap(r.data);
      ws.heatmapSubject = names;
      const near = shareWithinKm(ws, 5);
      return {
        summary: `${ws.heatmap.length} map cells for ${names.join(", ")}; ${near}% of affinity within 5 km of the venue`,
        forModel: JSON.stringify({ cells: ws.heatmap.length, share_within_5km_pct: near, mapped: names }),
        ...srcs(r),
      };
    }

    case "audience_demographics": {
      const { ids } = pickIds(ws, args.artist_names);
      const r = await qloo.insights({ "filter.type": "urn:demographics", "signal.interests.entities": ids.join(",") }, ctx);
      const names = new Map(ws.picks.map((p) => [p.entityId, p.name]));
      ws.demographics = parseDemographics(r.data, names);
      const top = ws.demographics.map((d) => `${d.name}: ${topBucket(d.age)}`);
      return {
        summary: top.length ? `Strongest age skew: ${top.join("; ")}` : "No demographic data returned",
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
        summary: `${ws.brands.length} brands (${locNote(near, loc)}); top: ${ws.brands.slice(0, 3).map((b) => b.name).join(", ")}`,
        forModel: JSON.stringify(ws.brands.map((b) => ({ name: b.name, affinity: b.affinity, category: b.category }))),
        ...srcs(r),
      };
    }

    case "partner_places": {
      const take = clampInt(args.take, 6, 3, 8);
      const r = await qloo.insights(
        { "filter.type": "urn:entity:place", "signal.interests.entities": seedIds(ws).join(","), "filter.location.query": loc, take },
        ctx,
      );
      ws.places = parseEntities(r.data).map(toPlace).sort((a, b) => b.affinity - a.affinity).slice(0, take);
      return {
        summary: `${ws.places.length} places${matchedLocality(r.data) ? ` in ${matchedLocality(r.data)}` : ""}; top: ${ws.places.slice(0, 3).map((p) => p.name).join(", ")}`,
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
      const pitch: Pitch = {
        headline: String(args.headline ?? "").slice(0, 200) || t.headline,
        summary: String(args.summary ?? "").slice(0, 1200) || t.summary,
        pickRationales: rationales.length ? rationales : t.pickRationales,
        sponsorAngle: String(args.sponsor_angle ?? "").slice(0, 600) || t.sponsorAngle,
        author: args.__template ? "template" : "llm",
      };
      ws.pitch = pitch;
      return { summary: `Pitch drafted: "${pitch.headline}"`, forModel: "Pitch saved. You are done.", sources: [], endpoints: [] };
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

export function shareWithinKm(ws: Workspace, km: number): number {
  if (ws.venue.needsGeocode) return 0;
  const total = ws.heatmap.reduce((s, p) => s + p.affinity, 0);
  if (!total) return 0;
  const near = ws.heatmap
    .filter((p) => haversineKm(ws.venue.lat, ws.venue.lng, p.lat, p.lng) <= km)
    .reduce((s, p) => s + p.affinity, 0);
  return Math.round((near / total) * 100);
}

export function topBucket(age: Record<string, number>): string {
  const e = Object.entries(age).sort((a, b) => b[1] - a[1])[0];
  // Demographic values are relative affinity scores (0 = average, + above, - below),
  // not percentages: https://docs.qloo.com/reference/demographics-use-case
  return e ? `${e[0].replace(/_/g, " ")} (${e[1] >= 0 ? "+" : ""}${e[1].toFixed(2)} vs. avg)` : "n/a";
}

const FIT_WORDS = { fits: "fits the room", stretch: "a stretch for the room", under: "may under-draw", unknown: "draw fit unknown" } as const;

/** Deterministic pitch built only from Workspace facts (used by the scripted planner and as a fallback). */
export function templatePitch(ws: Workspace): Pitch {
  const top3 = bookableFirst(ws.picks).slice(0, 3);
  const a = top3[0];
  const near = shareWithinKm(ws, 5);
  const brands = ws.brands.slice(0, 3).map((x) => x.name);
  const demo = ws.demographics[0];
  const cityShort = ws.venue.city.split(",")[0];
  return {
    headline: `${ws.venue.name}: ${a?.name ?? "The top pick"} is the strongest bookable taste fit for your next ${cityShort} headline night`,
    summary:
      `Fans of ${ws.seeds.map((s) => s.name).join(", ")} show the highest Qloo affinity for ${top3.map((p) => p.name).join(", ")}` +
      (ws.band ? `, all checked against a popularity band of ${bandLabel(ws.band.target)} for a ${ws.venue.capacity}-capacity room. ` : ". ") +
      (ws.heatmap.length && !ws.venue.needsGeocode ? `${near}% of the mapped local affinity sits within 5 km of the venue. ` : "") +
      (demo ? `The core crowd skews ${topBucket(demo.age)}.` : ""),
    pickRationales: top3.map((p) => ({
      artist: p.name,
      why:
        `Affinity ${pct(p.affinity)}/100${p.popularity !== undefined ? `, popularity ${pct(p.popularity)}/100 (${FIT_WORDS[p.drawFit ?? "unknown"]})` : ""}. ` +
        (p.sharedTags.length ? `Shares ${p.sharedTags.slice(0, 3).join(", ")} with the venue's taste profile.` : "Adjacent to the venue's taste profile."),
    })),
    sponsorAngle: brands.length
      ? `Lead with ${brands.join(", ")}: these brands score highest with this crowd${ws.brandsLocality ? ` in ${cityShort}` : ""}. Offer co-branded nights with ${ws.places[0]?.name ?? "a local partner"} as the pre-show spot.`
      : "No sponsor data yet.",
    author: "template",
  };
}
