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
    sample ? `> RECORDED DATA: replayed Qloo API responses${meta.recordedOn ? ` recorded on ${meta.recordedOn}` : ""}, not a live call. Re-run live before sending.\n` : "",
    `**Venue:** ${ws.venue.name}, ${ws.venue.city} (${ws.venue.capacity} capacity)  `,
    `**Past headliners:** ${ws.seeds.map((s) => s.name).join(", ")}  `,
    ws.band ? `**Room tier:** Qloo popularity ${bandLabel(ws.band.target)} for this capacity, a heuristic for draw (searched ${bandLabel(ws.band.used)})` : "",
    "",
    p.summary,
    "",
    "## Recommended acts",
    ...p.pickRationales.map((r) => `- **${r.artist}:** ${r.why}`),
    "",
    "## Ranked shortlist",
    "| # | Artist | Affinity | Popularity | Room tier | Driven by (Qloo explainability) |",
    "|---|---|---|---|---|---|",
    ...ws.picks.map(
      (a, i) =>
        `| ${i + 1} | ${a.name} | ${pct(a.affinity)} | ${pct(a.popularity)} | ${DRAW_FIT_TEXT[a.drawFit ?? "unknown"].short} | ${
          a.drivenBy?.length ? a.drivenBy.slice(0, 3).map((d) => `${d.name} ${pct(d.score)}%`).join(", ") : "-"
        } |`,
    ),
    ws.unavailable.includes("demographics") ? "\n_Audience demographics: unavailable on this Qloo key (HTTP 403)._" : "",
    ws.unavailable.includes("taste_profile") ? "_Venue taste profile: unavailable on this Qloo key (HTTP 403)._" : "",
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
    `Data: Qloo Insights API${sample ? ` (recorded${meta.recordedOn ? ` ${meta.recordedOn}` : ""})` : ", live"}. Text: ${p.author === "llm" ? meta.llm.label : "deterministic template"}.${p.checkNote ? ` ${p.checkNote}` : ""}`,
    "Affinity scores describe correlations in taste, not predictions about individuals or ticket sales.",
  ];
  return lines.join("\n");
}
