import { bandLabel, DRAW_FIT_TEXT } from "./band";
import type { StatusInfo, Workspace } from "./types";

const pct = (x?: number) => (x === undefined ? "-" : String(Math.round(x * 100)));

/** Markdown export of the pitch one-pager. */
export function pitchMarkdown(ws: Workspace, meta: StatusInfo): string {
  const p = ws.pitch;
  if (!p) return "";
  const sample = meta.qlooMode === "fixture";
  const lines = [
    `# ${p.headline}`,
    "",
    ws.partial ? "> PARTIAL: the agent hit its time budget; some sections may be missing.\n" : "",
    sample ? "> SAMPLE DATA: generated from illustrative fixtures, not live Qloo results. Do not send.\n" : "",
    `**Venue:** ${ws.venue.name}, ${ws.venue.city} (${ws.venue.capacity} capacity)  `,
    `**Past headliners:** ${ws.seeds.map((s) => s.name).join(", ")}  `,
    ws.band ? `**Draw-fit band:** Qloo popularity ${bandLabel(ws.band.target)} for this capacity (searched ${bandLabel(ws.band.used)})` : "",
    "",
    p.summary,
    "",
    "## Recommended acts",
    ...p.pickRationales.map((r) => `- **${r.artist}:** ${r.why}`),
    "",
    "## Ranked shortlist",
    "| # | Artist | Affinity | Popularity | Draw fit |",
    "|---|---|---|---|---|",
    ...ws.picks.map((a, i) => `| ${i + 1} | ${a.name} | ${pct(a.affinity)} | ${pct(a.popularity)} | ${DRAW_FIT_TEXT[a.drawFit ?? "unknown"].short} |`),
    "",
    "## Sponsor shortlist",
    ...ws.brands.map((b) => `- ${b.name} (${b.category ?? "brand"}), affinity ${pct(b.affinity)}`),
    "",
    p.sponsorAngle,
    "",
    "## Local partner spots",
    ...ws.places.map((x) => `- ${x.name}${x.address ? `, ${x.address}` : ""} (affinity ${pct(x.affinity)})`),
    "",
    "---",
    `Data: Qloo ${sample ? "(sample fixtures)" : "Insights API"}. Text: ${p.author === "llm" ? meta.llm.label : "deterministic template"}.`,
    "Affinity scores describe correlations in taste, not predictions about individuals.",
  ];
  return lines.join("\n");
}
