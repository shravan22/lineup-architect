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
  /** Recorded Qloo response set (presets only). Custom venues have none. */
  fixtureSet?: string;
  /** True when the user typed this venue in the custom form. */
  custom?: boolean;
  /** True when lat/lng are unknown and must be located via Qloo /search (live only). */
  needsGeocode?: boolean;
  /** Recorded-mode test scenario (ignored in live mode). See SIMULATIONS. */
  simulate?: Simulation;
}

/**
 * Recorded-mode scenarios for testing degraded live conditions:
 * - "403": urn:demographics and urn:tag insights answer HTTP 403, as on a hackathon
 *   key without those entity types.
 * - "no-explain": artist results come back without query.explainability.
 */
export type Simulation = "403" | "no-explain";
export const SIMULATIONS: Simulation[] = ["403", "no-explain"];

/** What the browser sends for a user-entered venue. Validated on the server. */
export interface CustomVenueRequest {
  name: string;
  cityId: string; // an id from lib/cities.ts, or "__other"
  otherCity?: string;
  capacity: number;
  headliners: string[];
  genre?: string;
}

/** Qloo popularity percentile band (0..1). */
export interface PopBand {
  min: number;
  max: number;
}

export type DrawFit = "under" | "fits" | "stretch" | "unknown";

export interface BandState {
  /** Band derived from the venue capacity; draw-fit badges use this one. */
  target: PopBand;
  /** Band used for the latest recommend_artists query (may be widened or narrowed). */
  used: PopBand;
  /** One line per query, e.g. "30-70: 5 acts in band". */
  history: string[];
}

export interface PendingChoice {
  query: string;
  candidates: { entityId: string; name: string; popularity?: number; description?: string; tags: string[] }[];
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
  drawFit?: DrawFit;
  /**
   * Qloo feature.explainability: which input headliners drove this pick
   * (result.query.explainability["signal.interests.entities"], scores 0..1).
   * Absent when Qloo returns no explainability for the result.
   */
  drivenBy?: Driver[];
}

export interface Driver {
  entityId: string;
  name: string;
  score: number; // 0..1, normalised by Qloo
}

/** Aggregate explainability (top-level query.explainability): average influence per seed. */
export interface ExplainSummary {
  /** e.g. "top5" -> drivers sorted by avg_score */
  subset: string;
  drivers: Driver[];
}

/** Agent step that the Qloo key is not allowed to call (HTTP 403). */
export type UnavailableSection = "taste_profile" | "demographics";

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
  /** Locality Qloo applied to the brand query, if any (brands may ignore signal.location). */
  brandsLocality?: string;
  places: PlacePick[];
  /** Aggregate Qloo explainability for the latest recommend_artists call. */
  explain?: ExplainSummary;
  /** Sections whose Qloo endpoint returned 403 for this key (shown as a note, not an error). */
  unavailable: UnavailableSection[];
  pitch?: Pitch;
  band?: BandState;
  /** Headliner searches with more than one plausible artist, waiting for a decision. */
  pending: PendingChoice[];
  /** Set when the time budget ran out and the result is incomplete. */
  partial?: boolean;
}

export interface LlmInfo {
  provider: "anthropic" | "gemini" | "scripted";
  model?: string;
  label: string;
}

export type AgentEvent =
  | { type: "meta"; qlooMode: QlooMode; llm: LlmInfo; recordedOn?: string }
  | { type: "thought"; text: string; by: "llm" | "scripted" | "system" }
  | { type: "decision"; by: "llm" | "scripted"; title: string; detail: string }
  | { type: "needs_live"; text: string; plan: string[] }
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
      /** True when Qloo refused the endpoint for this key (403): not an error, the run continues. */
      unavailable?: boolean;
      summary: string;
      ms: number;
      sources: DataSource[];
      endpoints: string[];
    }
  | { type: "workspace"; workspace: Workspace }
  | { type: "notice"; text: string }
  | { type: "done"; partial?: boolean; elapsedMs?: number }
  | { type: "error"; message: string };

export interface StatusInfo {
  qlooMode: QlooMode;
  llm: LlmInfo;
  /** Date the preset fixtures were recorded from the Qloo API (recorded mode label). */
  recordedOn?: string;
}
