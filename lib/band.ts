import type { DrawFit, PopBand } from "./types";

// Capacity -> Qloo popularity band.
//
// Qloo's `popularity` is a 0..1 percentile across all entities of a type. A
// small room cannot afford (or hold the crowd of) the most popular acts, and a
// very obscure act may not fill a large room. These cut-offs are a starting
// heuristic (Assumption, to be tuned against live Qloo data), not a measured
// relationship between popularity and ticket sales.
const BANDS: { maxCap: number; band: PopBand }[] = [
  { maxCap: 400, band: { min: 0.3, max: 0.7 } },
  { maxCap: 800, band: { min: 0.45, max: 0.82 } },
  { maxCap: 2000, band: { min: 0.6, max: 0.9 } },
  { maxCap: Infinity, band: { min: 0.75, max: 0.98 } },
];

export function capacityBand(capacity: number): PopBand {
  return { ...(BANDS.find((b) => capacity <= b.maxCap) ?? BANDS[BANDS.length - 1]).band };
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function widen(b: PopBand, step = 0.08): PopBand {
  return { min: r2(Math.max(0, b.min - step)), max: r2(Math.min(1, b.max + step)) };
}

export function narrowTop(b: PopBand, step = 0.08): PopBand {
  return { min: b.min, max: r2(Math.max(b.min + 0.1, b.max - step)) };
}

export function inBand(pop: number | undefined, b: PopBand): boolean {
  return pop !== undefined && pop >= b.min && pop <= b.max;
}

/** Draw fit of an act relative to the venue's capacity band (not the widened query band). */
export function drawFit(pop: number | undefined, b: PopBand): DrawFit {
  if (pop === undefined) return "unknown";
  if (pop < b.min) return "under";
  if (pop > b.max) return "stretch";
  return "fits";
}

export const bandLabel = (b: PopBand) => `${Math.round(b.min * 100)}-${Math.round(b.max * 100)}`;

export const DRAW_FIT_TEXT: Record<DrawFit, { short: string; long: string }> = {
  fits: { short: "Fits the room", long: "Qloo popularity is inside the band for this capacity" },
  stretch: { short: "Stretch", long: "More popular than the band: may cost more or outgrow the room" },
  under: { short: "Under-draw", long: "Less popular than the band: may not fill the room on its own" },
  unknown: { short: "Fit unknown", long: "Qloo returned no popularity for this act" },
};
