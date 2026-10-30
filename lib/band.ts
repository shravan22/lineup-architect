import type { DrawFit, PopBand } from "./types";

// Capacity -> Qloo popularity band ("the room's tier").
//
// Qloo's `popularity` is a 0..1 percentile across all artists, and it is heavily
// top-skewed: measured on the live hackathon API (2026-10-06, notes/qloo-docs-review.md
// item 4), the 15 preset headliners of 220-650-cap rooms sit at 0.47-0.997, and the
// acts Qloo recommends for them fall in 0.59-0.995 (recorded fixtures: London jazz
// 0.74-0.88, Nashville roots 0.59-0.92, Austin indie 0.82-0.95, Brooklyn rap
// 0.87-0.96, Detroit electronic 0.90-0.97). Arena-level acts are 0.997-1.0.
//
// `max` is the room's ceiling: acts above it are flagged "stretch". The ceilings
// were lowered on 2026-10-11 so a small room does not mark nearly every
// recommendation as in tier (a 220-cap room tops out at 0.86, so London acts at
// 0.86-0.88 become stretch picks). `reach` is how far above the ceiling the
// first query looks, so stretch candidates are visible and the agent can decide
// whether to cap the search at the ceiling.
//
// This is a heuristic fitted to those observations, not a measured relationship
// between popularity and ticket sales. Popularity is a proxy for draw.
const BANDS: { maxCap: number; band: PopBand; reach: number }[] = [
  { maxCap: 300, band: { min: 0.55, max: 0.86 }, reach: 0.07 },
  { maxCap: 600, band: { min: 0.8, max: 0.93 }, reach: 0.03 },
  { maxCap: 1200, band: { min: 0.88, max: 0.97 }, reach: 0.01 },
  { maxCap: 3000, band: { min: 0.94, max: 0.99 }, reach: 0.005 },
  { maxCap: Infinity, band: { min: 0.97, max: 1 }, reach: 0 },
];

/** Smallest band width the agent may query (popularity is dense near the top). */
export const MIN_BAND_WIDTH = 0.03;

const tier = (capacity: number) => BANDS.find((b) => capacity <= b.maxCap) ?? BANDS[BANDS.length - 1];

/** The room's tier: acts inside it are "in tier", above it "stretch", below it "under". */
export function capacityBand(capacity: number): PopBand {
  return { ...tier(capacity).band };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** First query: the room's tier plus a little headroom above it, so stretch picks are visible. */
export function searchBand(capacity: number): PopBand {
  const t = tier(capacity);
  return { min: t.band.min, max: r3(Math.min(1, t.band.max + t.reach)) };
}

/** Widen downwards only (more obscure acts); raising the top would only add stretch picks. */
export function widen(b: PopBand, step = 0.06): PopBand {
  return { min: r3(Math.max(0, b.min - step)), max: b.max };
}

/** Cap the query at the room's ceiling, dropping the stretch headroom. */
export function capAtCeiling(b: PopBand, target: PopBand): PopBand {
  return { min: b.min, max: r3(Math.max(b.min + MIN_BAND_WIDTH, Math.min(b.max, target.max))) };
}

export function inBand(pop: number | undefined, b: PopBand): boolean {
  return pop !== undefined && pop >= b.min && pop <= b.max;
}

/** Draw fit of an act relative to the venue's tier (not the query band). */
export function drawFit(pop: number | undefined, b: PopBand): DrawFit {
  if (pop === undefined) return "unknown";
  if (pop < b.min) return "under";
  if (pop > b.max) return "stretch";
  return "fits";
}

const pctLabel = (x: number) => String(Math.round(x * 1000) / 10);
export const bandLabel = (b: PopBand) => `${pctLabel(b.min)}-${pctLabel(b.max)}`;

export const DRAW_FIT_TEXT: Record<DrawFit, { short: string; long: string }> = {
  fits: { short: "Right size for the room", long: "Qloo popularity is inside the range for this capacity (a heuristic, not a ticket forecast)" },
  stretch: { short: "Stretch pick", long: "More popular than this room's range: may cost more or outgrow the room" },
  under: { short: "Smaller than the room", long: "Less popular than this room's range: may not fill the room on its own" },
  unknown: { short: "Size unknown", long: "Qloo returned no popularity for this act" },
};
