// Plain-language helpers for the UI. Everything here is derived from data the
// agent already returned; nothing predicts ticket sales or attendance.
import type { ArtistPick, DrawFit, HeatPoint, VenueInput, Workspace } from "./types";

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
  fits: "Right size for the room",
  stretch: "Stretch pick",
  under: "Smaller than the room",
  unknown: "Size unknown",
};

/** 1-based rank by Qloo affinity among all candidates ("#2 of 10"). */
export function tasteRank(p: ArtistPick, all: ArtistPick[]): number {
  return [...all].sort((a, b) => b.affinity - a.affinity).findIndex((x) => x.entityId === p.entityId) + 1;
}

const listNames = (n: string[]) => (n.length < 2 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`);

/** One plain-English sentence above the lineup: who to book and why. */
export function verdictLine(ws: Workspace): string | undefined {
  const h = ws.picks[0];
  if (!h) return undefined;
  const fans = h.drivenBy?.length ? h.drivenBy.slice(0, 2).map((d) => d.name) : ws.seeds.slice(0, 2).map((s) => s.name);
  const rank = tasteRank(h, ws.picks);
  const why = `${rank === 1 ? "the strongest" : `the #${rank}`} taste match with fans of ${listNames(fans)}`;
  const size =
    h.drawFit === "fits"
      ? `and the right size for ${ws.venue.capacity} cap`
      : h.drawFit === "stretch"
        ? `though bigger than a ${ws.venue.capacity}-cap room usually books`
        : h.drawFit === "under"
          ? `and smaller than a ${ws.venue.capacity}-cap room usually books`
          : "";
  return `Book ${h.name} to headline: ${why}${size ? `, ${size}` : ""}.`;
}

/** One visible line per support act: its top driver, else its shared sound. */
export function supportReason(p: ArtistPick): string | undefined {
  if (p.drivenBy?.length) return `Pulled in mostly by ${p.drivenBy[0].name} fans`;
  if (p.sharedTags.length) return `Shares your room's ${p.sharedTags.slice(0, 2).join(" and ").toLowerCase()} sound`;
  return undefined;
}

/** Higher taste matches left off the bill, and why ("#2 Floating Points: stretch pick"), so rank gaps on the cards make sense. */
export function skippedAbove(ws: Workspace, bill: ArtistPick[]): { rank: number; name: string; why: string }[] {
  const worst = Math.max(...bill.map((p) => tasteRank(p, ws.picks)));
  const why = { fits: "kept as a backup", stretch: "bigger than the room", under: "smaller than the room", unknown: "size unknown" } as const;
  return ws.picks
    .filter((p) => !bill.includes(p) && tasteRank(p, ws.picks) < worst)
    .map((p) => ({ rank: tasteRank(p, ws.picks), name: p.name, why: why[p.drawFit ?? "unknown"] }))
    .sort((a, b) => a.rank - b.rank);
}

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
  // Custom venues are placed at the city centre (no street address).
  const where = venue.custom ? "the city centre" : "the venue";
  if (venue.needsGeocode || points.length < 5) return undefined;
  const near = (p: HeatPoint) => km(venue.lat, venue.lng, p.lat, p.lng) <= HOT_KM;
  const hot = [...points].sort((a, b) => b.affinity - a.affinity).slice(0, Math.ceil(points.length / 5));
  const pct = (l: HeatPoint[]) => Math.round((l.filter(near).length / l.length) * 100);
  const hotPct = pct(hot);
  const allPct = pct(points);
  const ratio = allPct > 0 ? hotPct / allPct : undefined;
  const verdict =
    ratio === undefined
      ? `Few map areas sit near ${where}, so no comparison`
      : ratio > NEAR_LIFT_MIN
        ? `Concentrated near ${where}: ${ratio.toFixed(1)}x the city-wide share`
        : ratio <= 0.77
          ? `Concentrated away from ${where}`
          : `Spread across the city, not just near ${where}`;
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
