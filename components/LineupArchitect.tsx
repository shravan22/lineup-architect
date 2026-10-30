"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState } from "react";
import { bandLabel, capacityBand, DRAW_FIT_TEXT } from "@/lib/band";
import { CITIES, OTHER_CITY } from "@/lib/cities";
import type { AgentEvent, ArtistPick, CustomVenueRequest, DataSource, StatusInfo, VenueInput, Workspace } from "@/lib/types";
import { pitchMarkdown } from "@/lib/pitch";
import { concentration, plannerLabel, roomTier, supportReason, tasteRank, tasteWord, VERDICT, verdictLine } from "@/lib/ui";

const AffinityMap = dynamic(() => import("./AffinityMap"), {
  ssr: false,
  loading: () => <div className="map map-loading">Loading map...</div>,
});

/** The agent's plan, shown before a run and ticked off live during it (one row per stage, tool names from lib/agent/tools.ts). */
const PLAN: { tools: string[]; text: string; chip: string }[] = [
  { tools: ["locate_city", "search_artist", "resolve_headliner"], text: "Find your past headliners on Qloo", chip: "search" },
  { tools: ["find_genre_tags", "taste_profile"], text: "Read your room's sound from their tags", chip: "tags" },
  { tools: ["recommend_artists"], text: "Rank acts their fans love, sized to your room", chip: "insights" },
  { tools: ["audience_heatmap"], text: "Map where that taste lives in the city", chip: "heatmap" },
  { tools: ["audience_demographics"], text: "Profile the crowd's age and gender lean", chip: "demographics" },
  { tools: ["sponsor_brands", "partner_places"], text: "Shortlist sponsor brands and partner spots", chip: "brands · places" },
  { tools: ["write_pitch"], text: "Write the booking pitch", chip: "LLM" },
];

type RowState = "pending" | "running" | "ok" | "error" | "skipped";

interface Step {
  id: string;
  name?: string;
  kind: "tool" | "thought" | "notice" | "decision";
  label: string;
  detail?: string;
  status: "running" | "ok" | "error" | "info" | "unavailable";
  by?: string;
  ms?: number;
  sources?: DataSource[];
  endpoints?: string[];
}

type RunState = "idle" | "running" | "done" | "error";
const CUSTOM = "__custom";

const pct = (x?: number) => (x === undefined ? "-" : String(Math.round(x * 100)));

const AGE_LABELS: Record<string, string> = {
  "24_and_younger": "24 and under",
  "25_to_29": "25-29",
  "30_to_34": "30-34",
  "35_to_44": "35-44",
  "45_to_54": "45-54",
  "55_and_older": "55+",
};

const EMPTY_FORM: CustomVenueRequest & { headliners: string[] } = {
  name: "",
  cityId: "chicago",
  otherCity: "",
  capacity: 400,
  headliners: ["", "", ""],
  genre: "",
};

type Tab = "map" | "audience" | "sponsors";

/** Planner name without model IDs or failure wording; the full text stays in the tooltip and the log. */
function plannerShort(llm: { provider: string; label: string; note?: string }): string {
  if (llm.provider === "scripted") return /\((?:.* )?(failed|quota reached|too slow|stopped early)\)$/.test(llm.label) ? "rule-based (fallback)" : "rule-based";
  return `${llm.label.replace(/\s*\(.*\)\s*$/, "")}${llm.note ? " (fallback)" : ""}`;
}

export default function LineupArchitect({ status, venues }: { status: StatusInfo; venues: VenueInput[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? "");
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunState>("idle");
  const [steps, setSteps] = useState<Step[]>([]);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [meta, setMeta] = useState<StatusInfo>(status);
  const [needsLive, setNeedsLive] = useState<{ text: string; plan: string[] } | null>(null);
  const [partial, setPartial] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(true);
  const [tab, setTab] = useState<Tab>("map");
  const abortRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const isCustom = venueId === CUSTOM;
  const venue = venues.find((v) => v.id === venueId);
  const sample = meta.qlooMode === "fixture";
  const recLabel = `Recorded from the Qloo API${meta.recordedOn ? ` on ${meta.recordedOn}` : ""}`;

  const handle = useCallback((e: AgentEvent) => {
    switch (e.type) {
      case "meta":
        setMeta({ qlooMode: e.qlooMode, llm: e.llm, recordedOn: e.recordedOn });
        break;
      case "thought":
        setSteps((s) => [...s, { id: crypto.randomUUID(), kind: "thought", label: e.text, status: "info", by: e.by }]);
        break;
      case "decision":
        setSteps((s) => [...s, { id: crypto.randomUUID(), kind: "decision", label: e.title, detail: e.detail, status: "info", by: e.by }]);
        break;
      case "notice":
        setSteps((s) => [...s, { id: crypto.randomUUID(), kind: "notice", label: e.text, status: "info" }]);
        break;
      case "needs_live":
        setNeedsLive({ text: e.text, plan: e.plan });
        break;
      case "tool_start":
        setSteps((s) => [
          ...s,
          { id: e.id, name: e.name, kind: "tool", label: e.label, detail: Object.keys(e.args).length ? JSON.stringify(e.args) : undefined, status: "running" },
        ]);
        break;
      case "tool_end":
        setSteps((s) =>
          s.map((x) =>
            x.id === e.id ? { ...x, status: e.unavailable ? "unavailable" : e.ok ? "ok" : "error", detail: e.summary, ms: e.ms, sources: e.sources, endpoints: e.endpoints } : x,
          ),
        );
        break;
      case "workspace":
        setWs(e.workspace);
        break;
      case "error":
        setError(e.message);
        setRunState("error");
        break;
      case "done":
        setPartial(!!e.partial);
        setElapsed(e.elapsedMs ?? null);
        setRunState((r) => (r === "error" ? r : "done"));
        setLogOpen(false);
        break;
    }
  }, []);

  const run = useCallback(async () => {
    let payload: object;
    if (isCustom) {
      const headliners = form.headliners.map((h) => h.trim()).filter(Boolean);
      const err = !form.name.trim()
        ? "Give the venue a name."
        : form.cityId === OTHER_CITY && (form.otherCity ?? "").trim().length < 2
          ? "Type the city name."
          : !(form.capacity >= 50 && form.capacity <= 20000)
            ? "Capacity must be between 50 and 20000."
            : !headliners.length
              ? "Add at least one past headliner."
              : null;
      setFormError(err);
      if (err) return;
      payload = { custom: { ...form, headliners } };
    } else {
      payload = { venueId };
    }
    // Sample-mode test scenarios: ?simulate=403 or ?simulate=no-explain (ignored live).
    const simulate = new URLSearchParams(window.location.search).get("simulate");
    if (simulate) payload = { ...payload, simulate };
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setSteps([]);
    setWs(null);
    setError(null);
    setNeedsLive(null);
    setPartial(false);
    setElapsed(null);
    setLogOpen(true);
    setPickerOpen(false);
    setTab("map");
    setRunState("running");
    requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `Request failed (HTTP ${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) handle(JSON.parse(line) as AgentEvent);
        }
      }
      setRunState((r) => (r === "running" ? "done" : r));
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Something went wrong");
      setRunState("error");
    }
  }, [venueId, handle, isCustom, form]);

  const md = useMemo(() => (ws?.pitch ? pitchMarkdown(ws, meta) : ""), [ws, meta]);
  const conc = useMemo(() => (ws && ws.heatmap.length ? concentration(ws.venue, ws.heatmap) : undefined), [ws]);

  const download = () => {
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${ws?.venue.id ?? "pitch"}-pitch.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const setHeadliner = (i: number, v: string) => setForm((f) => ({ ...f, headliners: f.headliners.map((h, j) => (j === i ? v : h)) }));
  const formBand = capacityBand(form.capacity || 0);
  const formTier = roomTier(form.capacity || 0);

  const tools = steps.filter((s) => s.kind === "tool");
  const toolsDone = tools.filter((s) => s.status !== "running").length;
  const decisions = steps.filter((s) => s.kind === "decision");
  const current = [...tools].reverse().find((s) => s.status === "running");
  const planRows = PLAN.map((row) => {
    const mine = tools.filter((s) => s.name && row.tools.includes(s.name));
    const state: RowState = mine.some((s) => s.status === "running")
      ? "running"
      : mine.some((s) => s.status === "ok" || s.status === "unavailable")
        ? "ok"
        : mine.some((s) => s.status === "error")
          ? "error"
          : runState === "done" || runState === "error"
            ? "skipped"
            : "pending";
    const last = [...mine].reverse().find((s) => s.status !== "running" && s.detail);
    return { ...row, state, detail: last?.detail, unavailable: mine.some((s) => s.status === "unavailable") };
  });
  const headliner = ws?.picks[0];
  const support = ws?.picks.slice(1, 3) ?? [];
  const others = ws?.picks.slice(3) ?? [];
  const tier = ws ? roomTier(ws.venue.capacity) : undefined;
  const fitCount = ws?.picks.filter((p) => p.drawFit === "fits").length ?? 0;
  const planner = plannerLabel(meta.llm);
  const plannerText = plannerShort(meta.llm);

  const collapsed = !pickerOpen && runState !== "idle";
  const chipLabel = isCustom
    ? `${form.name.trim() || "Your venue"} · ${form.capacity} cap`
    : venue
      ? `${venue.city} · ${venue.name} · ${venue.capacity} cap`
      : "";

  const tabs: { id: Tab; label: string }[] = ws
    ? [
        ...(ws.heatmap.length > 0 ? [{ id: "map" as Tab, label: "Crowd map" }] : []),
        ...(ws.demographics.length > 0 || ws.unavailable.includes("demographics") ? [{ id: "audience" as Tab, label: "Audience" }] : []),
        ...(ws.brands.length > 0 || ws.places.length > 0 ? [{ id: "sponsors" as Tab, label: "Sponsors" }] : []),
      ]
    : [];
  const activeTab = tabs.find((t) => t.id === tab)?.id ?? tabs[0]?.id;

  // One label set for presets and custom venues.
  const runLabel = runState === "running" ? "Agent working..." : runState === "idle" ? "Plan the next booking" : "Run again";

  const planList = (live: boolean) => (
    <ol className={`plan-rows ${live ? "is-live" : ""}`}>
      {planRows.map((r, i) => (
        <li key={r.text} className={`plan-row row-${live ? r.state : "pending"}`}>
          <span className="row-icon" aria-hidden="true">
            {!live || r.state === "pending" ? i + 1 : r.state === "running" ? <span className="spinner" /> : r.state === "ok" ? "✓" : r.state === "error" ? "!" : "–"}
          </span>
          <span className="row-text">
            {r.text}
            {live && r.state === "skipped" && <span className="row-note"> (skipped by the planner)</span>}
            {live && r.unavailable && <span className="row-note"> (unavailable on this key)</span>}
            {live && r.detail && r.state === "ok" && <span className="row-detail">{r.detail}</span>}
          </span>
          <span className="endpoint-chip" title="Qloo API or model call used for this step">
            {r.chip}
          </span>
        </li>
      ))}
    </ol>
  );

  const runButton = (
    <button className="run" onClick={run} disabled={runState === "running" || (!venue && !isCustom)}>
      {runState === "running" && <span className="spinner spinner-dark" aria-hidden="true" />}
      {runLabel}
      {runState !== "running" && <span aria-hidden="true"> →</span>}
    </button>
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            LA
          </span>
          <span className="brand-name">Lineup Architect</span>
        </div>
        <div className="badges" aria-label="Data and agent mode">
          {sample ? (
            <span className="badge badge-sample" title={`${recLabel}. No Qloo API key on this server: preset results are real Qloo API responses recorded earlier and replayed, not live calls.`}>
              <i className="dot-ind" aria-hidden="true" />
              Recorded Qloo data
            </span>
          ) : (
            <span className="badge badge-live" title="Every Qloo call in this run goes to the live hackathon API (repeat calls within 24 h may be served from the server cache, marked 'cache' in the log).">
              <i className="dot-ind" aria-hidden="true" />
              Live Qloo API
            </span>
          )}
          <span className="badge badge-plain" title={`${planner.text}. ${planner.title}`}>
            Planner: {plannerText}
          </span>
        </div>
      </header>

      <section className="setup" aria-labelledby="hero-h">
        <h1 id="hero-h">
          Book the acts <span className="hl">your neighbourhood</span> already loves.
        </h1>
        <p className="lede">
          For talent buyers at 200-2,000-cap rooms: an agent that reads <strong>Qloo taste data</strong>, books acts sized to your room and writes the
          pitch.
        </p>
        {sample && (
          <p className="banner" role="note" title="The scores are Qloo's, just not fetched right now (trimmed to the fields the app reads).">
            <strong>Recorded mode:</strong> the sample venues replay real Qloo API responses{meta.recordedOn ? ` from ${meta.recordedOn}` : ""}. Your own
            venue needs a live key.
          </p>
        )}

        {collapsed ? (
          <div className="venue-chip-row">
            <span className="venue-chip">
              <span className="sr-only">Venue: </span>
              {chipLabel}
              <button className="linkish" onClick={() => setPickerOpen(true)} disabled={runState === "running"}>
                Change
              </button>
            </span>
            {runButton}
          </div>
        ) : (
          <>
            <fieldset className="venues">
              <legend className="sr-only">Venues</legend>
              {venues.map((v) => (
                <label key={v.id} className={`venue ${v.id === venueId ? "selected" : ""}`}>
                  <input type="radio" name="venue" value={v.id} checked={v.id === venueId} onChange={() => setVenueId(v.id)} />
                  <span className="venue-city">{v.city}</span>
                  <span className="venue-name">{v.name}</span>
                  <span className="venue-meta">
                    {v.capacity} cap · {v.genreHint}
                  </span>
                </label>
              ))}
              <label className={`venue venue-custom ${isCustom ? "selected" : ""}`}>
                <input type="radio" name="venue" value={CUSTOM} checked={isCustom} onChange={() => setVenueId(CUSTOM)} />
                <span className="venue-city">Any city</span>
                <span className="venue-name">+ Your venue</span>
                <span className="venue-meta">{sample ? "Needs a live Qloo key" : "Your room, your headliners"}</span>
              </label>
            </fieldset>

            <div className="selected-bar">
              {!isCustom && venue && (
                <p className="selected-info" title={venue.blurb}>
                  {roomTier(venue.capacity).name} · past headliners (the taste signal): <strong>{venue.headliners.join(", ")}</strong>
                </p>
              )}

              {isCustom && (
                <form
                  className="custom-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run();
                  }}
                  noValidate
                >
                  <label>
                    Venue name
                    <input value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. The Velvet Room" required />
                  </label>
                  <div className="row">
                    <label>
                      City
                      <select value={form.cityId} onChange={(e) => setForm({ ...form, cityId: e.target.value })}>
                        <optgroup label="United States">
                          {CITIES.filter((c) => c.region === "US").map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="Europe">
                          {CITIES.filter((c) => c.region === "Europe").map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                            </option>
                          ))}
                        </optgroup>
                        <option value={OTHER_CITY}>Other (located via Qloo)</option>
                      </select>
                    </label>
                    <label className="cap">
                      Capacity
                      <input
                        type="number"
                        min={50}
                        max={20000}
                        step={10}
                        value={form.capacity || ""}
                        onChange={(e) => setForm({ ...form, capacity: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  {form.cityId === OTHER_CITY && (
                    <label>
                      City name
                      <input value={form.otherCity} maxLength={60} onChange={(e) => setForm({ ...form, otherCity: e.target.value })} placeholder="e.g. Leeds" />
                    </label>
                  )}
                  <fieldset className="heads">
                    <legend>Past headliners (1-3): acts that did well in your room</legend>
                    {form.headliners.map((h, i) => (
                      <input
                        key={i}
                        value={h}
                        maxLength={80}
                        aria-label={`Past headliner ${i + 1}`}
                        placeholder={["e.g. Khruangbin", "optional", "optional"][i]}
                        onChange={(e) => setHeadliner(i, e.target.value)}
                      />
                    ))}
                  </fieldset>
                  <label>
                    Genre focus <small>(optional)</small>
                    <input value={form.genre} maxLength={40} onChange={(e) => setForm({ ...form, genre: e.target.value })} placeholder="e.g. psych rock" />
                  </label>
                  {form.capacity >= 50 && (
                    <p className="hint" title="The agent caps the search at the ceiling if stretch acts crowd the list, or widens it if too few acts fit.">
                      {`A ${form.capacity}-cap room is a ${formTier.name.toLowerCase()} (${formTier.range}): the agent looks for Qloo popularity ${bandLabel(formBand)}.`}
                    </p>
                  )}
                  {formError && (
                    <p className="error" role="alert">
                      {formError}
                    </p>
                  )}
                </form>
              )}

              {runButton}
            </div>
            {runState === "idle" && (
              <div className="plan-preview">
                <h2 className="mini-h">What the agent will do</h2>
                {planList(false)}
              </div>
            )}
          </>
        )}
      </section>

      <div className="workspace" ref={resultsRef}>
        {runState !== "idle" && (
          <section className="agent" aria-labelledby="agent-h" aria-live="polite">
            <div className="agent-stats">
              <h2 id="agent-h" className="mini-h">
                Agent run
              </h2>
              <span className="stat">
                <strong>{runState === "running" ? `${toolsDone}/${tools.length || "-"}` : toolsDone}</strong> Qloo calls
              </span>
              <span className="stat">
                <strong>{decisions.length}</strong> judgement call{decisions.length === 1 ? "" : "s"}
              </span>
              {elapsed !== null && !needsLive && (
                <span className="stat">
                  <strong>{(elapsed / 1000).toFixed(1)}</strong> s{partial ? " (time budget reached)" : ""}
                </span>
              )}
              <span className="stat stat-planner" title={planner.title}>
                planner: {plannerText}
              </span>
            </div>
            {runState === "running" && (
              <p className="agent-now">
                <span className="spinner" aria-hidden="true" /> {current ? `Now: ${current.label}` : "Starting the agent..."}
              </p>
            )}
            {!needsLive && planList(true)}
            {decisions.length > 0 && (
              <ul className="agent-decisions">
                {decisions.slice(0, 3).map((d) => (
                  <li key={d.id} title={d.detail}>
                    {d.label}
                  </li>
                ))}
                {decisions.length > 3 && <li className="more-note">+{decisions.length - 3} more in the full log</li>}
              </ul>
            )}

            {steps.length > 0 && (
              <details className="log" open={logOpen} onToggle={(e) => setLogOpen(e.currentTarget.open)}>
                <summary>{logOpen ? "Hide full log" : `Show full log (${steps.length} steps)`}</summary>
                <ol className="trace">
                  {steps.map((s) => (
                    <li key={s.id} className={`step step-${s.kind} step-${s.status}`}>
                      {s.kind === "tool" ? (
                        <>
                          <span className="step-icon" aria-hidden="true">
                            {s.status === "running" ? <span className="spinner" /> : s.status === "ok" ? "✓" : s.status === "unavailable" ? "–" : "!"}
                          </span>
                          <div className="step-main">
                            <div className="step-label">
                              {s.label}
                              {s.status === "unavailable" && <span className="src src-unavailable">unavailable on hackathon key</span>}
                              {s.sources?.map((src, i) => (
                                <span key={i} className={`src src-${src}`}>
                                  {src === "fixture" ? "recorded" : src}
                                </span>
                              ))}
                              {s.ms !== undefined && <span className="ms">{s.ms} ms</span>}
                            </div>
                            {s.detail && <div className="step-detail">{s.detail}</div>}
                            {s.endpoints && s.endpoints.length > 0 && <div className="step-endpoint">{s.endpoints.join(", ")}</div>}
                          </div>
                        </>
                      ) : s.kind === "decision" ? (
                        <div className="decision">
                          <span className="tag tag-decision">Judgement call</span>
                          <span className="decision-by">{s.by === "llm" ? "by the LLM agent" : "by the rule-based planner"}</span>
                          <div className="decision-title">{s.label}</div>
                          {s.detail && <div className="decision-detail">{s.detail}</div>}
                        </div>
                      ) : (
                        <p className="thought">
                          <span className="who">{s.kind === "notice" ? "Notice" : s.by === "llm" ? "Agent plan" : "Planner"}</span> {s.label}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </section>
        )}

        {error && (
          <p className="error" role="alert">
            {error} <button onClick={run}>Retry</button>
          </p>
        )}

        {needsLive && (
          <div className="card-block needs-live" role="status">
            <h3>Needs a live Qloo key</h3>
            <p>{needsLive.text}</p>
            <p className="caption">With a key, the agent would run these steps for your venue:</p>
            <ol className="plan">
              {needsLive.plan.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ol>
            <p className="caption">Meanwhile, try one of the five sample venues to see the full flow on recorded Qloo responses.</p>
          </div>
        )}

        {partial && ws && (
          <p className="banner partial" role="note">
            <strong>Partial result.</strong> The agent hit its time budget before every step finished. Each section with data is complete; the pitch is a
            template.
          </p>
        )}

        {!needsLive && !ws?.picks.length && runState === "running" && (
          <div className="placeholder" aria-hidden="true">
            <div className="skeleton tall" />
            <div className="skeleton-row">
              <div className="skeleton" />
              <div className="skeleton" />
            </div>
          </div>
        )}
        {!needsLive && !ws?.picks.length && runState === "done" && <p className="empty">The agent finished without candidates. Check the full log for errors.</p>}

        {ws && headliner && (
          <div className={`answer ${ws.pitch ? "has-pitch" : ""}`}>
            <section className="card-block lineup" aria-labelledby="lineup-h">
              <h2 id="lineup-h" className="sec-h">
                Recommended lineup
              </h2>
              {verdictLine(ws) && <p className="verdict-line">{verdictLine(ws)}</p>}
              {ws.band && tier && (
                <p
                  className="room-line"
                  title={`${ws.venue.name} holds ${ws.venue.capacity}. Acts sized for this room have Qloo popularity ${bandLabel(ws.band.target)} (a 0-100 rank of how widely known an act is; the capacity-to-range mapping is a heuristic). Last search covered ${bandLabel(ws.band.used)}. Queries: ${ws.band.history.join("; ")}`}
                >
                  Sized for a {tier.name.toLowerCase()} ({ws.venue.capacity} cap): {fitCount} of {ws.picks.length} acts the agent found are the right size
                  {ws.band.used.max > ws.band.target.max ? ", plus a few bigger stretch picks" : ""}.
                </p>
              )}

              <article className="headliner" aria-label={`Headliner pick: ${headliner.name}`}>
                <span className="slot">Headliner</span>
                <h3 className="act-name">{headliner.name}</h3>
                <ActMeta p={headliner} all={ws.picks} />
                {headliner.shortDescription && <p className="act-desc">{headliner.shortDescription}</p>}
                <Why p={headliner} open />
              </article>

              {support.length > 0 && (
                <div className="support">
                  {support.map((p, i) => (
                    <article key={p.entityId} className="support-card" aria-label={`Support pick ${i + 1}: ${p.name}`}>
                      <span className="slot">Support {i + 1}</span>
                      <h3 className="act-name small">{p.name}</h3>
                      <p className="support-reason">{supportReason(p, ws.picks)}</p>
                      <ActMeta p={p} all={ws.picks} />
                      <Why p={p} />
                    </article>
                  ))}
                </div>
              )}

              <details className="more">
                <summary>
                  Details: all {ws.picks.length} acts considered ({fitCount} the right size), your room&apos;s sound, how to read this
                </summary>
                {ws.unavailable.includes("taste_profile") && (
                  <p className="unavail-note" role="note">
                    Venue taste profile unavailable on this Qloo key (urn:tag returned 403). Acts are ranked without the shared-tag check.
                    {ws.venue.simulate === "403" && " (Simulated 403 in recorded mode.)"}
                  </p>
                )}
                {ws.tasteTags.length > 0 && (
                  <p className="taste">
                    <span className="mini-h">Your room&apos;s sound, per Qloo tags:</span>
                    {ws.tasteTags.slice(0, 6).map((t) => (
                      <span key={t.id} className="chip">
                        {t.name}
                      </span>
                    ))}
                  </p>
                )}
                {others.length > 0 && (
                  <>
                    <h4 className="mini-h">Also considered</h4>
                    <ol className="others-list" start={4}>
                      {others.map((p) => (
                        <li key={p.entityId}>
                          <span className="others-name">{p.name}</span>
                          <span className={`verdict verdict-${p.drawFit ?? "unknown"}`} title={DRAW_FIT_TEXT[p.drawFit ?? "unknown"].long}>
                            {VERDICT[p.drawFit ?? "unknown"]}
                          </span>
                          <span className="others-score" title={`Qloo affinity ${pct(p.affinity)}/100, popularity ${pct(p.popularity)}/100`}>
                            #{tasteRank(p, ws.picks)} taste match
                          </span>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
                <h4 className="mini-h">How to read this</h4>
                <dl className="glossary">
                  <dt>Taste match (Qloo affinity)</dt>
                  <dd>How strongly fans of your past headliners also like this act, on Qloo&apos;s 0-100 scale. Hover a match label to see the score.</dd>
                  <dt>Popularity and room size</dt>
                  <dd>
                    Qloo popularity is a 0-100 rank of how widely known an act is. Each room tier maps to a popularity range (a heuristic tuned on
                    real Qloo data). “Right size for the room” means the act&apos;s popularity sits inside that range, “Stretch pick” means it is more
                    widely known (likely pricier or a bigger room), “Smaller than the room” means less known. Popularity is a proxy for draw, not a
                    ticket forecast.
                  </dd>
                  <dt>Driven by (Qloo explainability)</dt>
                  <dd>Qloo reports which of your past headliners pulled each act into the results, and by how much.</dd>
                </dl>
              </details>
            </section>

            {ws.pitch && (
              <article className="card-block pitch" aria-labelledby="pitch-h">
                <div className="pitch-head">
                  <h2 id="pitch-h" className="sec-h">
                    Booking pitch
                  </h2>
                  <div className="pitch-actions">
                    <button onClick={download}>Download .md</button>
                    <button onClick={() => window.print()}>Print / PDF</button>
                  </div>
                </div>
                <div className="pitch-paper">
                  <h4>{ws.pitch.headline}</h4>
                  <p>{ws.pitch.summary}</p>
                  <h5>Recommended acts</h5>
                  <ul>
                    {ws.pitch.pickRationales.map((r) => (
                      <li key={r.artist}>
                        <strong>{r.artist}:</strong> {r.why}
                      </li>
                    ))}
                  </ul>
                  <h5>Sponsor angle</h5>
                  <p>{ws.pitch.sponsorAngle}</p>
                  <p className="provenance">
                    {sample && <strong>Built from recorded Qloo responses ({meta.recordedOn ?? "earlier run"}): re-run live before sending. </strong>}
                    Data: Qloo Insights API{sample ? `, ${recLabel.replace("Recorded from the Qloo API", "recorded")}` : ", live"}. Text:{" "}
                    {ws.pitch.author === "llm" ? `written by ${meta.llm.label} from the Qloo results` : "deterministic template"}. Affinity scores describe
                    correlations in taste, not predictions about individuals or ticket sales.
                  </p>
                  {ws.pitch.checkNote && <p className="provenance">{ws.pitch.checkNote}</p>}
                </div>
              </article>
            )}
          </div>
        )}

        {ws && activeTab && (
          <section className="card-block evidence" aria-label="Evidence behind the lineup">
            <div className="tabs" role="tablist" aria-label="Evidence">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-selected={activeTab === t.id}
                  aria-controls={`panel-${t.id}`}
                  tabIndex={activeTab === t.id ? 0 : -1}
                  className={`tab ${activeTab === t.id ? "is-active" : ""}`}
                  onClick={() => setTab(t.id)}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                    const i = tabs.findIndex((x) => x.id === activeTab);
                    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
                    setTab(next.id);
                    document.getElementById(`tab-${next.id}`)?.focus();
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div role="tabpanel" id={`panel-${activeTab}`} aria-labelledby={`tab-${activeTab}`} className="tabpanel">
              {activeTab === "map" && (
                <>
                  <p className="stat-line">
                    {conc && (
                      <>
                        <strong>{conc.verdict}.</strong> {conc.hotPct}% of the hottest areas are within {conc.km} km of{" "}
                        {ws.venue.custom ? "the city centre" : "the venue"}, vs {conc.allPct}% of all mapped areas.{" "}
                      </>
                    )}
                    <span className="faint">
                      Qloo taste for {ws.heatmapSubject.join(", ")} across {ws.venue.city}: relative taste, not fan counts.
                    </span>
                  </p>
                  <AffinityMap venue={ws.venue} points={ws.heatmap} places={ws.places} />
                  <div className="legend" aria-hidden="true">
                    <span className="ramp">
                      <span>Lower taste</span>
                      <i style={{ background: "#fee08b" }} />
                      <i style={{ background: "#fdae61" }} />
                      <i style={{ background: "#f46d43" }} />
                      <i style={{ background: "#d73027" }} />
                      <i style={{ background: "#a50026" }} />
                      <span>Higher</span>
                    </span>
                    <span>
                      <i className="dot venue-dot" />
                      {ws.venue.custom ? "City centre" : "Venue"}
                    </span>
                    <span>
                      <i className="dot place-dot" />
                      Partner spot
                    </span>
                  </div>
                </>
              )}

              {activeTab === "audience" &&
                (ws.demographics.length === 0 ? (
                  <p className="unavail-note" role="note">
                    Unavailable on the hackathon key: Qloo answered 403 for audience demographics (urn:demographics), so age and gender skew is not shown.
                    The rest of the plan and the pitch do not depend on it.
                    {ws.venue.simulate === "403" && " (Simulated 403 in recorded mode.)"}
                  </p>
                ) : (
                  <>
                    <p className="stat-line faint">Fans&apos; age and gender lean vs the average Qloo user: right of the line = more likely than average.</p>
                    <div className="demo-grid">
                      {ws.demographics.map((d) => (
                        <figure key={d.entityId} className="demo">
                          <figcaption>{d.name}</figcaption>
                          <table className="skew">
                            <tbody>
                              {Object.entries(d.age).map(([k, v]) => (
                                <SkewRow key={k} label={AGE_LABELS[k] ?? k} v={v} />
                              ))}
                              {Object.entries(d.gender).map(([k, v]) => (
                                <SkewRow key={k} label={k} v={v} />
                              ))}
                            </tbody>
                          </table>
                        </figure>
                      ))}
                    </div>
                  </>
                ))}

              {activeTab === "sponsors" && (
                <div className="two-col">
                  <div>
                    <h4 className="mini-h">Brands to pitch</h4>
                    <ol className="list">
                      {ws.brands.map((b) => (
                        <li key={b.entityId}>
                          <span>
                            <strong>{b.name}</strong> <small>{b.category}</small>
                          </span>
                          <span className="score" title="Qloo affinity with this crowd, 0-100">
                            {pct(b.affinity)}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div>
                    <h4 className="mini-h">Local partner spots</h4>
                    <ol className="list">
                      {ws.places.map((p) => (
                        <li key={p.entityId}>
                          <span>
                            <strong>{p.name}</strong> <small>{p.category}</small>
                          </span>
                          <span className="score" title="Qloo affinity with this crowd, 0-100">
                            {pct(p.affinity)}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <p className="fineprint">Numbers are Qloo taste-match scores (0-100) with this crowd.</p>
                </div>
              )}
            </div>
          </section>
        )}
      </div>
      <footer className="foot">
        Lineup Architect, built for the Qloo Agentic Hackathon. Taste data from Qloo. Map tiles &copy; OpenStreetMap contributors.
      </footer>
    </div>
  );
}

/** Two plain labels: taste match (rank by Qloo affinity) and act size (Qloo popularity vs the room). Raw scores on hover. */
function ActMeta({ p, all }: { p: ArtistPick; all: ArtistPick[] }) {
  const fit = p.drawFit ?? "unknown";
  return (
    <div className="act-meta">
      <span className="match" title={`Taste match: Qloo affinity ${pct(p.affinity)}/100, how strongly fans of your past headliners like this act`}>
        <span className="match-word">{tasteWord(p.affinity)}</span>
        <span className="match-num">
          #{tasteRank(p, all)} of {all.length}
        </span>
      </span>
      <span
        className={`verdict verdict-${fit}`}
        title={`How big the act is: Qloo popularity ${pct(p.popularity)}/100 (how widely known). ${DRAW_FIT_TEXT[fit].long}`}
      >
        {VERDICT[fit]}
      </span>
    </div>
  );
}

function Why({ p, open }: { p: ArtistPick; open?: boolean }) {
  const hasDrivers = !!p.drivenBy && p.drivenBy.length > 0;
  if (!hasDrivers && p.sharedTags.length === 0) return null;
  return (
    <details className="why" open={open}>
      <summary>Why this act?</summary>
      {hasDrivers && (
        <div className="card-driven" title="Qloo feature.explainability: how much each past headliner contributed to this recommendation">
          Driven by fans of:{" "}
          {p.drivenBy!.slice(0, 3).map((d, j) => (
            <span key={d.entityId}>
              {j > 0 && ", "}
              <strong>{d.name}</strong> {Math.round(d.score * 100)}%
            </span>
          ))}
          <span className="driven-bar" aria-hidden="true">
            {p.drivenBy!.slice(0, 3).map((d, j) => (
              <i key={d.entityId} className={`seg seg-${j}`} style={{ width: `${Math.round(d.score * 100)}%` }} />
            ))}
          </span>
        </div>
      )}
      {p.sharedTags.length > 0 && <div className="card-tags">Shares your room&apos;s sound: {p.sharedTags.join(", ")}</div>}
    </details>
  );
}

function SkewRow({ label, v }: { label: string; v: number }) {
  const w = Math.min(50, Math.abs(v) * 50);
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>
        <div className="skewbar" aria-hidden="true">
          <span className={v >= 0 ? "pos" : "neg"} style={v >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />
        </div>
      </td>
      <td className="num">
        {v >= 0 ? "+" : ""}
        {v.toFixed(2)}
      </td>
    </tr>
  );
}
