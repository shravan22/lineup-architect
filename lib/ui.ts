// Plain-language helpers for the UI. Everything here is derived from data the
// agent already returned; nothing predicts ticket sales or attendance.
import type { DrawFit, HeatPoint, VenueInput } from "./types";

/** Named room tiers. Capacity cut-offs mirror the band table in lib/band.ts. */
const TIERS: { maxCap: number; name: string; range: string }[] = [
  { maxCap: 300, name: "Small club", range: "up to 300 cap" },
  { maxCap: 600, name: "Club room", range: "301-600 cap" },
  { maxCap: 1200, name: "Large club", range: "601-1,200 cap" },
  { maxCap: 3000, name: "Theatre", range: "1,201-3,000 cap" },
  { maxCap: Infinity, name: "Arena-scale", range: "3,000+ cap" },
];

export function roomTier(capacity: number) {
  return TIERS.find((t) => capacity <= t.maxCap) ?? TIERS[TIERS.length - 1];
}

/** Qloo affinity (0..1) in words. The raw score stays available on hover. */
export function tasteWord(a: number): string {
  if (a >= 0.9) return "Very strong taste match";
  if (a >= 0.75) return "Strong taste match";
  if (a >= 0.5) return "Moderate taste match";
  return "Light taste match";
}

/** Verdict chip text for the draw-fit check (Qloo popularity vs the room's band). */
export const VERDICT: Record<DrawFit, string> = {
  fits: "In this room's tier",
  stretch: "Stretch pick",
  under: "Below this room's tier",
  unknown: "Tier unknown",
};

const HOT_KM = 2;

/** Hot-cell share near the venue must beat the city-wide share by this factor to count as concentrated (also used by the pitch check). */
export const NEAR_LIFT_MIN = 1.1;

function km(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Same comparison the agent's heatmap tool reports (lib/agent/tools.ts hotspots):
 * share of the hottest fifth of map cells within 2 km of the venue vs the share of
 * all cells. Undefined when the venue position is unknown or there are too few cells.
 */
export function concentration(venue: VenueInput, points: HeatPoint[]) {
  if (venue.needsGeocode || points.length < 5) return undefined;
  const near = (p: HeatPoint) => km(venue.lat, venue.lng, p.lat, p.lng) <= HOT_KM;
  const hot = [...points].sort((a, b) => b.affinity - a.affinity).slice(0, Math.ceil(points.length / 5));
  const pct = (l: HeatPoint[]) => Math.round((l.filter(near).length / l.length) * 100);
  const hotPct = pct(hot);
  const allPct = pct(points);
  const ratio = allPct > 0 ? hotPct / allPct : undefined;
  const verdict =
    ratio === undefined
      ? "Few map areas sit near the venue, so no comparison"
      : ratio > NEAR_LIFT_MIN
        ? `Concentrated near the venue: ${ratio.toFixed(1)}x the city-wide share`
        : ratio <= 0.77
          ? "Concentrated away from the venue"
          : "Spread across the city, not just near the venue";
  return { hotPct, allPct, ratio, verdict, km: HOT_KM };
}

/** Plain-language planner label. The raw label (with model or fallback reason) stays in the tooltip. */
export function plannerLabel(llm: { provider: string; label: string; note?: string }): { text: string; title: string } {
  if (llm.provider !== "scripted")
    return {
      text: `Planner: ${llm.label}${llm.note ? " (fallback)" : ""}`,
      title: `An LLM decides which Qloo tool to call next and writes the pitch${llm.note ? `. ${llm.note[0].toUpperCase()}${llm.note.slice(1)}.` : ""}`,
    };
  // Handover labels look like "Scripted planner (<model> failed|quota reached|too slow|stopped early)" (lib/agent/run.ts).
  const why = llm.label.match(/(failed|quota reached|too slow|stopped early)\)$/)?.[1];
  return {
    text: why ? `Planner: rule-based fallback (LLM ${why})` : "Planner: rule-based (no LLM key on this server)",
    title: `${llm.label}. The same agent loop and Qloo tools, with a deterministic planner making the decisions instead of an LLM.`,
  };
}
