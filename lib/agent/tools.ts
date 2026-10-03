import "server-only";
import { qloo, type QlooResult } from "@/lib/qloo/client";
import {
  parseDemographics,
  parseEntities,
  parseHeatmap,
  parseSearch,
  parseTagList,
  toBrand,
  toPlace,
} from "@/lib/qloo/normalize";
import type { ArtistPick, DataSource, Pitch, Workspace } from "@/lib/types";

// Agent tools. Each tool calls Qloo (or the sample fixtures), writes structured
// results into the shared Workspace (which the UI renders), and returns a compact
// text result for the LLM. Qloo facts live in the Workspace; LLM text is only
// used for the pitch narrative, so data and interpretation stay separate.

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
}

type Args = Record<string, unknown>;

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "search_artist",
    label: "Resolve past headliner",
    description: "Resolve one of the venue's past headliners to a Qloo artist entity ID using Qloo /search. Call once per headliner.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Artist name exactly as the venue wrote it" } },
      required: ["name"],
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
    description: "Get the taste tags with the highest affinity to the resolved headliners (Qloo insights, filter.type=urn:tag). Requires resolved headliners.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "recommend_artists",
    label: "Rank candidate acts",
    description:
      "Rank artists by Qloo affinity to the venue's past headliners and genre tags, localised to the venue's city (Qloo insights, filter.type=urn:entity:artist). Excludes the past headliners.",
    parameters: {
      type: "object",
      properties: { take: { type: "number", description: "How many candidates (5-15). Default 10." } },
    },
  },
  {
    name: "audience_heatmap",
    label: "Map local affinity",
    description:
      "Get a geographic heatmap of taste affinity in the venue's city for the given artists (Qloo insights, filter.type=urn:heatmap). Defaults to the top 3 candidates.",
    parameters: {
      type: "object",
      properties: { artist_names: { type: "array", items: { type: "string" }, description: "Candidate names to map (optional)" } },
    },
  },
  {
    name: "audience_demographics",
    label: "Profile the audience",
    description: "Get age and gender skew of fans for the given artists (Qloo insights, filter.type=urn:demographics). Defaults to the top 3 candidates.",
    parameters: {
      type: "object",
      properties: { artist_names: { type: "array", items: { type: "string" }, description: "Candidate names (optional)" } },
    },
  },
  {
    name: "sponsor_brands",
    label: "Shortlist sponsor brands",
    description:
      "Find brands with high affinity among fans of the headliners and the top candidates, in the venue's city (Qloo insights, filter.type=urn:entity:brand).",
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
      "Finish by writing the one-page booking pitch. Only cite facts returned by earlier tools. Do not state causation or claims about individuals.",
    parameters: {
      type: "object",
      properties: {
        headline: { type: "string", description: "One-line pitch headline" },
        summary: { type: "string", description: "2-3 sentence summary for the talent buyer" },
        pick_rationales: {
          type: "array",
          description: "Why each of the top 3 acts fits, citing affinity and shared tags",
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

export const TOOL_LABELS = Object.fromEntries(TOOL_SPECS.map((t) => [t.name, t.label]));

const pct = (x: number) => Math.round(x * 100);
const srcs = (...r: QlooResult[]) => ({ sources: r.map((x) => x.source), endpoints: r.map((x) => x.endpoint) });

function seedIds(ws: Workspace): string[] {
  if (!ws.seeds.length) throw new Error("No headliners resolved yet. Call search_artist first.");
  return ws.seeds.map((s) => s.entityId);
}

function pickIds(ws: Workspace, names: unknown): { ids: string[]; names: string[] } {
  let chosen = ws.picks.slice(0, 3);
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

export async function runTool(name: string, args: Args, ws: Workspace): Promise<ToolOutcome> {
  const loc = ws.venue.locationQuery;
  switch (name) {
    case "search_artist": {
      const q = String(args.name ?? "").trim();
      if (!q) throw new Error("name is required");
      const r = await qloo.search(q, "urn:entity:artist", 3);
      const hits = parseSearch(r.data);
      const hit =
        hits.find((h) => h.name.toLowerCase() === q.toLowerCase() && (h.types.includes("urn:entity:artist") || !h.types.length)) ??
        hits.find((h) => h.types.includes("urn:entity:artist")) ??
        hits[0];
      if (!hit) return { summary: `No Qloo match for "${q}"`, forModel: `No match for ${q}.`, ...srcs(r) };
      ws.seeds = [...ws.seeds.filter((s) => s.entityId !== hit.entityId), { query: q, entityId: hit.entityId, name: hit.name, popularity: hit.popularity, imageUrl: hit.imageUrl }];
      return {
        summary: `"${q}" -> ${hit.name} (${hits.length} candidate${hits.length === 1 ? "" : "s"})`,
        forModel: JSON.stringify({ resolved: hit.name, entity_id: hit.entityId, popularity: hit.popularity }),
        ...srcs(r),
      };
    }

    case "find_genre_tags": {
      const q = String(args.query ?? ws.venue.genreHint);
      const r = await qloo.tags(q, 5);
      const tags = parseTagList(r.data).slice(0, 3);
      ws.genreTags = tags;
      return {
        summary: tags.length ? `${tags.length} tags: ${tags.map((t) => t.name).join(", ")}` : `No tags for "${q}"`,
        forModel: JSON.stringify(tags.map((t) => ({ id: t.id, name: t.name }))),
        ...srcs(r),
      };
    }

    case "taste_profile": {
      const r = await qloo.insights({
        "filter.type": "urn:tag",
        "filter.parents.types": "urn:entity:artist",
        "signal.interests.entities": seedIds(ws).join(","),
        take: 10,
      });
      ws.tasteTags = parseTagList(r.data);
      return {
        summary: `Top tags: ${ws.tasteTags.slice(0, 4).map((t) => t.name).join(", ")}`,
        forModel: JSON.stringify(ws.tasteTags.map((t) => ({ name: t.name, affinity: t.affinity }))),
        ...srcs(r),
      };
    }

    case "recommend_artists": {
      const take = clampInt(args.take, 10, 5, 15);
      const seeds = seedIds(ws);
      const r = await qloo.insights({
        "filter.type": "urn:entity:artist",
        "signal.interests.entities": seeds.join(","),
        "signal.interests.tags": ws.genreTags.map((t) => t.id).join(",") || undefined,
        "signal.location.query": loc,
        "filter.exclude.entities": seeds.join(","),
        take,
      });
      const tasteNames = new Set(ws.tasteTags.map((t) => t.name.toLowerCase()));
      const picks: ArtistPick[] = parseEntities(r.data)
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
        }))
        .sort((a, b) => b.affinity - a.affinity)
        .slice(0, take);
      ws.picks = picks;
      return {
        summary: `${picks.length} acts ranked; top: ${picks.slice(0, 3).map((p) => `${p.name} ${pct(p.affinity)}`).join(", ")}`,
        forModel: JSON.stringify(
          picks.map((p) => ({ name: p.name, affinity: p.affinity, popularity: p.popularity, shared_tags: p.sharedTags })),
        ),
        ...srcs(r),
      };
    }

    case "audience_heatmap": {
      const { ids, names } = pickIds(ws, args.artist_names);
      const r = await qloo.insights({
        "filter.type": "urn:heatmap",
        "signal.interests.entities": ids.join(","),
        "filter.location.query": loc,
      });
      ws.heatmap = parseHeatmap(r.data);
      ws.heatmapSubject = names;
      const near = shareWithinKm(ws, 5);
      return {
        summary: `${ws.heatmap.length} map cells; ${near}% of affinity weight within 5 km of the venue`,
        forModel: JSON.stringify({ cells: ws.heatmap.length, share_within_5km_pct: near, mapped: names }),
        ...srcs(r),
      };
    }

    case "audience_demographics": {
      const { ids } = pickIds(ws, args.artist_names);
      const r = await qloo.insights({ "filter.type": "urn:demographics", "signal.interests.entities": ids.join(",") });
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
      const ids = [...seedIds(ws), ...ws.picks.slice(0, 3).map((p) => p.entityId)];
      const r = await qloo.insights({
        "filter.type": "urn:entity:brand",
        "signal.interests.entities": ids.join(","),
        "signal.location.query": loc,
        take,
      });
      ws.brands = parseEntities(r.data).map(toBrand).sort((a, b) => b.affinity - a.affinity).slice(0, take);
      return {
        summary: `${ws.brands.length} brands; top: ${ws.brands.slice(0, 3).map((b) => b.name).join(", ")}`,
        forModel: JSON.stringify(ws.brands.map((b) => ({ name: b.name, affinity: b.affinity, category: b.category }))),
        ...srcs(r),
      };
    }

    case "partner_places": {
      const take = clampInt(args.take, 6, 3, 8);
      const r = await qloo.insights({
        "filter.type": "urn:entity:place",
        "signal.interests.entities": seedIds(ws).join(","),
        "filter.location.query": loc,
        take,
      });
      ws.places = parseEntities(r.data).map(toPlace).sort((a, b) => b.affinity - a.affinity).slice(0, take);
      return {
        summary: `${ws.places.length} places; top: ${ws.places.slice(0, 3).map((p) => p.name).join(", ")}`,
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
      const pitch: Pitch = {
        headline: String(args.headline ?? "").slice(0, 200) || templatePitch(ws).headline,
        summary: String(args.summary ?? "").slice(0, 1200) || templatePitch(ws).summary,
        pickRationales: rationales.length ? rationales : templatePitch(ws).pickRationales,
        sponsorAngle: String(args.sponsor_angle ?? "").slice(0, 600) || templatePitch(ws).sponsorAngle,
        author: args.__template ? "template" : "llm",
      };
      ws.pitch = pitch;
      return { summary: `Pitch drafted: "${pitch.headline}"`, forModel: "Pitch saved. You are done.", sources: [], endpoints: [] };
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ---- helpers ----

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function shareWithinKm(ws: Workspace, km: number): number {
  const total = ws.heatmap.reduce((s, p) => s + p.affinity, 0);
  if (!total) return 0;
  const near = ws.heatmap
    .filter((p) => haversineKm(ws.venue.lat, ws.venue.lng, p.lat, p.lng) <= km)
    .reduce((s, p) => s + p.affinity, 0);
  return Math.round((near / total) * 100);
}

export function topBucket(age: Record<string, number>): string {
  const e = Object.entries(age).sort((a, b) => b[1] - a[1])[0];
  return e ? `${e[0].replace(/_/g, " ")} (+${pct(e[1])}% vs. avg)` : "n/a";
}

/** Deterministic pitch built only from Workspace facts (used by the scripted planner). */
export function templatePitch(ws: Workspace): Pitch {
  const [a, b, c] = ws.picks;
  const top3 = [a, b, c].filter(Boolean);
  const near = shareWithinKm(ws, 5);
  const brands = ws.brands.slice(0, 3).map((x) => x.name);
  const demo = ws.demographics[0];
  return {
    headline: `${ws.venue.name}: ${a?.name ?? "The top pick"} is the strongest taste fit for your next ${ws.venue.city.split(",")[0]} headline night`,
    summary:
      `Fans of ${ws.seeds.map((s) => s.name).join(", ")} show the highest Qloo affinity for ${top3.map((p) => p.name).join(", ")}. ` +
      (ws.heatmap.length ? `${near}% of the mapped local affinity sits within 5 km of the venue. ` : "") +
      (demo ? `The core crowd skews ${topBucket(demo.age)}.` : ""),
    pickRationales: top3.map((p) => ({
      artist: p.name,
      why: `Affinity ${pct(p.affinity)}/100${p.popularity !== undefined ? `, popularity ${pct(p.popularity)}/100` : ""}. ` +
        (p.sharedTags.length ? `Shares ${p.sharedTags.slice(0, 3).join(", ")} with the venue's taste profile.` : "Adjacent to the venue's taste profile."),
    })),
    sponsorAngle: brands.length
      ? `Lead with ${brands.join(", ")}: these brands score highest with this crowd in ${ws.venue.city.split(",")[0]}. Offer co-branded nights with ${ws.places[0]?.name ?? "a local partner"} as the pre-show spot.`
      : "No sponsor data yet.",
    author: "template",
  };
}
