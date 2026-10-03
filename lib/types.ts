// Shared types used by both the server (agent) and the browser (UI).
// Nothing in this file may reference secrets or server-only modules.

export type QlooMode = "live" | "fixture";
export type DataSource = "live" | "cache" | "fixture";

export interface VenueInput {
  id: string;
  name: string;
  city: string;
  /** Free-text location passed to Qloo as signal.location.query / filter.location.query */
  locationQuery: string;
  capacity: number;
  lat: number;
  lng: number;
  /** Past headliners the venue has booked (names, resolved via /search) */
  headliners: string[];
  /** A genre phrase used to look up Qloo tag IDs via /v2/tags */
  genreHint: string;
  blurb: string;
}

export interface ResolvedEntity {
  query: string;
  entityId: string;
  name: string;
  popularity?: number;
  imageUrl?: string;
}

export interface TagInfo {
  id: string;
  name: string;
  type?: string;
  affinity?: number;
}

export interface ArtistPick {
  entityId: string;
  name: string;
  affinity: number; // 0..1 from Qloo query.affinity
  popularity?: number; // 0..1
  imageUrl?: string;
  tags: TagInfo[];
  sharedTags: string[]; // tag names shared with the venue taste profile
  shortDescription?: string;
}

export interface HeatPoint {
  lat: number;
  lng: number;
  affinity: number; // 0..1
  popularity?: number;
  geohash?: string;
}

export interface DemoProfile {
  entityId: string;
  name: string;
  /** Relative skew vs. Qloo baseline, roughly -1..1 per bucket */
  age: Record<string, number>;
  gender: Record<string, number>;
}

export interface BrandPick {
  entityId: string;
  name: string;
  affinity: number;
  popularity?: number;
  category?: string;
}

export interface PlacePick {
  entityId: string;
  name: string;
  affinity: number;
  address?: string;
  category?: string;
  lat?: number;
  lng?: number;
}

export interface Pitch {
  headline: string;
  summary: string;
  pickRationales: { artist: string; why: string }[];
  sponsorAngle: string;
  author: "llm" | "template";
}

export interface Workspace {
  venue: VenueInput;
  seeds: ResolvedEntity[];
  genreTags: TagInfo[];
  tasteTags: TagInfo[];
  picks: ArtistPick[];
  heatmap: HeatPoint[];
  heatmapSubject: string[];
  demographics: DemoProfile[];
  brands: BrandPick[];
  places: PlacePick[];
  pitch?: Pitch;
}

export interface LlmInfo {
  provider: "anthropic" | "scripted";
  model?: string;
  label: string;
}

export type AgentEvent =
  | { type: "meta"; qlooMode: QlooMode; llm: LlmInfo }
  | { type: "thought"; text: string; by: "llm" | "scripted" | "system" }
  | {
      type: "tool_start";
      id: string;
      name: string;
      label: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_end";
      id: string;
      ok: boolean;
      summary: string;
      ms: number;
      sources: DataSource[];
      endpoints: string[];
    }
  | { type: "workspace"; workspace: Workspace }
  | { type: "notice"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface StatusInfo {
  qlooMode: QlooMode;
  llm: LlmInfo;
}
