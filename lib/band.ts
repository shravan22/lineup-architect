import type { DrawFit, PopBand } from "./types";

// Capacity -> Qloo popularity band.
//
// Qloo's `popularity` is a 0..1 percentile across all artists, and it is heavily
// top-skewed: measured on the live hackathon API (2026-10-06, notes/qloo-docs-review.md
// item 4), the 15 preset headliners of 220-650-cap rooms sit at 0.47-0.997
// (Nashville roots acts 0.47-0.69, London jazz 0.88-0.95, Austin indie 0.90-0.96,
// Brooklyn rap 0.91-0.97, Detroit electronic 0.98-0.997), and the acts Qloo
// recommends for them fall in 0.81-0.995. Arena-level acts are 0.997-1.0. The bands
// below follow that spread. They are a heuristic fitted to those observations,
// not a measured relationship between popularity and ticket sales.
const BANDS: { maxCap: number; band: PopBand }[] = [
  { maxCap: 300, band: { min: 0.55, max: 0.93 } },
  { maxCap: 600, band: { min: 0.8, max: 0.96 } },
  { maxCap: 1200, band: { min: 0.88, max: 0.98 } },
  { maxCap: 3000, band: { min: 0.94, max: 0.993 } },
  { maxCap: Infinity, band: { min: 0.97, max: 1 } },
];

/** Smallest band width the agent may query (popularity is dense near the top). */
export const MIN_BAND_WIDTH = 0.03;

export function capacityBand(capacity: number): PopBand {
  return { ...(BANDS.find((b) => capacity <= b.maxCap) ?? BANDS[BANDS.length - 1]).band };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Widen: mostly downwards (more obscure acts), a little upwards, because the scale is compressed near 1. */
export function widen(b: PopBand, step = 0.06): PopBand {
  return { min: r3(Math.max(0, b.min - step)), max: r3(Math.min(1, b.max + step / 4)) };
}

export function narrowTop(b: PopBand, step = 0.02): PopBand {
  return { min: b.min, max: r3(Math.max(b.min + MIN_BAND_WIDTH, b.max - step)) };
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

const pctLabel = (x: number) => String(Math.round(x * 1000) / 10);
export const bandLabel = (b: PopBand) => `${pctLabel(b.min)}-${pctLabel(b.max)}`;

export const DRAW_FIT_TEXT: Record<DrawFit, { short: string; long: string }> = {
  fits: { short: "Fits the room", long: "Qloo popularity is inside the band for this capacity" },
  stretch: { short: "Stretch", long: "More popular than the band: may cost more or outgrow the room" },
  under: { short: "Under-draw", long: "Less popular than the band: may not fill the room on its own" },
  unknown: { short: "Fit unknown", long: "Qloo returned no popularity for this act" },
};
