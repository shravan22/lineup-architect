"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState } from "react";
import { bandLabel, capacityBand, DRAW_FIT_TEXT } from "@/lib/band";
import { CITIES, OTHER_CITY } from "@/lib/cities";
import type { AgentEvent, ArtistPick, CustomVenueRequest, DataSource, StatusInfo, VenueInput, Workspace } from "@/lib/types";
import { pitchMarkdown } from "@/lib/pitch";
import { concentration, plannerLabel, roomTier, tasteWord, VERDICT } from "@/lib/ui";

const AffinityMap = dynamic(() => import("./AffinityMap"), {
  ssr: false,
  loading: () => <div className="map map-loading">Loading map...</div>,
});

interface Step {
  id: string;
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

const FLOW = [
  { n: "01", title: "Pick a venue", text: "A sample club, or your own room: city, capacity and a few past headliners." },
  { n: "02", title: "Watch the agent work", text: "It plans its own Qloo calls, checks results and makes booking decisions live." },
  { n: "03", title: "Get a lineup + pitch", text: "A headliner and support acts sized to your room, the local crowd map, sponsors and a ready pitch." },
];

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
  const [traceOpen, setTraceOpen] = useState(true);
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
          { id: e.id, kind: "tool", label: e.label, detail: Object.keys(e.args).length ? JSON.stringify(e.args) : undefined, status: "running" },
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
    setTraceOpen(true);
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
  const stage = runState === "idle" ? 0 : runState === "running" ? 1 : ws?.pitch ? 2 : 1;

  const headliner = ws?.picks[0];
  const support = ws?.picks.slice(1, 3) ?? [];
  const others = ws?.picks.slice(3) ?? [];
  const tier = ws ? roomTier(ws.venue.capacity) : undefined;
  const planner = plannerLabel(meta.llm);
  const keyMoves = steps.filter((s) => s.kind === "decision" || s.kind === "notice");

  const runLabel =
    runState === "running"
      ? "Agent working..."
      : isCustom
        ? sample
          ? "Plan with live Qloo data"
          : "Plan the next booking"
        : runState === "idle"
          ? "Plan the next booking"
          : "Run again";

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
            <span className="badge badge-sample" title="No Qloo API key on this server: preset results are real Qloo API responses recorded earlier and replayed, not live calls.">
              <i className="dot-ind" aria-hidden="true" />
              {recLabel}
            </span>
          ) : (
            <span className="badge badge-live" title="Every Qloo call in this run goes to the live hackathon API (repeat calls within 24 h may be served from the server cache, marked 'cache' in the trace).">
              <i className="dot-ind" aria-hidden="true" />
              Live Qloo API
            </span>
          )}
          <span className={`badge ${meta.llm.provider === "scripted" ? "badge-scripted" : "badge-llm"}`} title={planner.title}>
            {planner.text}
          </span>
        </div>
      </header>

      <section className="hero" aria-labelledby="hero-h">
        <p className="kicker">AI booking agent for independent venues</p>
        <h1 id="hero-h">
          Book the acts <span className="hl">your neighbourhood</span> already loves.
        </h1>
        <p className="lede">
          For talent buyers at 200-2,000-cap rooms with no analytics team. Lineup Architect is an agent that uses <strong>Qloo taste data</strong> to
          find artists whose fans overlap with your past headliners, checks they suit your room size, maps where that taste is concentrated in your
          city, and writes the booking pitch.
        </p>
        <ol className="flow" aria-label="How it works">
          {FLOW.map((f, i) => (
            <li key={f.n} className={`flow-step ${stage === i ? "is-now" : stage > i ? "is-done" : ""}`} aria-current={stage === i ? "step" : undefined}>
              <span className="flow-n">{stage > i ? "✓" : f.n}</span>
              <div>
                <strong>{f.title}</strong>
                <span>{f.text}</span>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {sample && (
        <p className="banner" role="note">
          <strong>Recorded mode.</strong> This server has no Qloo API key, so the five sample venues replay real Qloo API responses{" "}
          {meta.recordedOn ? `recorded on ${meta.recordedOn}` : "recorded earlier"} (trimmed to the fields the app reads). The scores are Qloo&apos;s,
          just not fetched right now. Your own venue needs a live key.
        </p>
      )}

      <section className="block setup" aria-labelledby="setup-h">
        <div className="block-head">
          <span className="block-n">01</span>
          <div>
            <h2 id="setup-h">Pick a venue</h2>
            <p className="caption">Each sample is a real kind of room. The agent uses its past headliners as the taste signal and its capacity to size the acts.</p>
          </div>
        </div>
        <fieldset className="venues">
          <legend className="sr-only">Venues</legend>
          {venues.map((v) => (
            <label key={v.id} className={`venue ${v.id === venueId ? "selected" : ""}`}>
              <input type="radio" name="venue" value={v.id} checked={v.id === venueId} onChange={() => setVenueId(v.id)} />
              <span className="venue-city">{v.city}</span>
              <span className="venue-name">{v.name}</span>
              <span className="venue-meta">
                {v.capacity} cap · {roomTier(v.capacity).name} · {v.genreHint}
              </span>
            </label>
          ))}
          <label className={`venue venue-custom ${isCustom ? "selected" : ""}`}>
            <input type="radio" name="venue" value={CUSTOM} checked={isCustom} onChange={() => setVenueId(CUSTOM)} />
            <span className="venue-city">Any city</span>
            <span className="venue-name">+ Your venue</span>
            <span className="venue-meta">Your capacity and past headliners{sample ? " (needs a live Qloo key)" : ""}</span>
          </label>
        </fieldset>

        <div className="selected-bar">
          {!isCustom && venue && (
            <div className="selected-info">
              <p className="venue-blurb">{venue.blurb}</p>
              <p className="venue-heads">
                Past headliners (the taste signal): <strong>{venue.headliners.join(", ")}</strong>
              </p>
            </div>
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
              <p className="hint">
                {form.capacity >= 50
                  ? `A ${form.capacity}-cap room is a ${formTier.name.toLowerCase()} (${formTier.range}): the agent looks for acts with Qloo popularity ${bandLabel(formBand)}. `
                  : ""}
                It widens or narrows that range if too few or too many acts fit.
              </p>
              {formError && (
                <p className="error" role="alert">
                  {formError}
                </p>
              )}
            </form>
          )}

          <button className="run" onClick={run} disabled={runState === "running" || (!venue && !isCustom)}>
            {runState === "running" && <span className="spinner spinner-dark" aria-hidden="true" />}
            {runLabel}
            {runState !== "running" && <span aria-hidden="true"> →</span>}
          </button>
        </div>
      </section>

      <div className="workspace" ref={resultsRef}>
        <aside className="block rail" aria-labelledby="trace-h">
          <div className="block-head">
            <span className="block-n">02</span>
            <div>
              <h2 id="trace-h">Watch the agent work</h2>
              <p className="caption">Every Qloo call the planner chose to make, what came back, and each decision it took, streamed as it happens.</p>
            </div>
          </div>

          <div className="progress" aria-live="polite">
            {runState === "idle" ? (
              <span>Waiting for a venue. Press “{runLabel}” to start.</span>
            ) : (
              <>
                <span className="prog-stat">
                  <strong>{toolsDone}</strong>/{tools.length || "-"} Qloo tool calls
                </span>
                <span className="prog-stat">
                  <strong>{decisions.length}</strong> decision{decisions.length === 1 ? "" : "s"}
                </span>
                {runState === "running" && current && <span className="prog-now">Now: {current.label}</span>}
                {runState === "done" && elapsed !== null && !needsLive && (
                  <span className="prog-now">
                    Finished in {(elapsed / 1000).toFixed(1)} s{partial ? " (partial: time budget reached)" : ""}
                  </span>
                )}
              </>
            )}
          </div>
          {runState === "running" && tools.length > 0 && (
            <div className="progbar" aria-hidden="true">
              <span style={{ width: `${Math.round((toolsDone / Math.max(tools.length, 1)) * 100)}%` }} />
            </div>
          )}

          {steps.length > 0 && (
            <button className="linkish" aria-expanded={traceOpen} aria-controls="trace-list" onClick={() => setTraceOpen((o) => !o)}>
              {traceOpen ? "Hide step-by-step log" : `Show step-by-step log (${steps.length} steps)`}
            </button>
          )}

          <div id="trace-list" hidden={!traceOpen}>
            {runState === "idle" && (
              <ul className="legend-list">
                <li>
                  <span className="tag tag-tool">Tool</span> a call to the Qloo API (search, taste tags, insights, map)
                </li>
                <li>
                  <span className="tag tag-decision">Decision</span> the agent changes course, e.g. picks the right artist for an ambiguous name or widens the
                  search
                </li>
                <li>
                  <span className="tag tag-thought">Plan</span> what it intends to do next
                </li>
              </ul>
            )}
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
                      <div className="decision-head">
                        <span className="tag tag-decision">Decision</span>
                        <span className="decision-by">{s.by === "llm" ? "by the LLM agent" : "by the scripted planner"}</span>
                      </div>
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
            {runState === "running" && steps.length === 0 && <p className="empty">Starting the agent...</p>}
          </div>
          {error && (
            <p className="error" role="alert">
              {error} <button onClick={run}>Retry</button>
            </p>
          )}
        </aside>

        <section className="results" aria-labelledby="results-h">
          <div className="block-head">
            <span className="block-n">03</span>
            <div>
              <h2 id="results-h">Your lineup and pitch</h2>
              <p className="caption">The agent&apos;s recommendation first, then the evidence behind it: where the crowd is, who they are, and who could sponsor.</p>
            </div>
          </div>

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

          {!needsLive && !ws?.picks.length && (
            <div className="card-block placeholder">
              {runState === "running" ? (
                <>
                  <p className="placeholder-title">
                    <span className="spinner" aria-hidden="true" /> The agent is querying Qloo{current ? `: ${current.label.toLowerCase()}` : "..."}
                  </p>
                  <div className="skeleton tall" />
                  <div className="skeleton-row">
                    <div className="skeleton" />
                    <div className="skeleton" />
                  </div>
                </>
              ) : runState === "done" ? (
                <p className="empty">The agent finished without candidates. Check the agent log for errors.</p>
              ) : (
                <div className="placeholder-idle">
                  <p className="placeholder-title">Nothing booked yet.</p>
                  <p className="caption">
                    Pick a venue above and press “{runLabel}”. In a few seconds you get a headliner and two support acts, a map of where their taste is
                    concentrated, the fans&apos; age and gender mix, brands to pitch for sponsorship, and a pitch you can download.
                  </p>
                </div>
              )}
            </div>
          )}

          {ws && headliner && (
            <div className="card-block lineup">
              <div className="card-head">
                <h3>Recommended lineup {sample && <span className="badge badge-sample small">Recorded</span>}</h3>
                <p className="caption">
                  Ranked by Qloo taste match with your past headliners, with acts that suit your room size listed first.
                </p>
              </div>

              {ws.band && tier && (
                <p className="room-line" title={`Qloo popularity is a 0-100 rank of how widely known an artist is. The capacity-to-range mapping is a heuristic. Queries: ${ws.band.history.join("; ")}`}>
                  <span className="room-tier">
                    {tier.name} · {tier.range}
                  </span>
                  <span>
                    {ws.venue.name} holds {ws.venue.capacity}, so the agent looked for acts with Qloo popularity <strong>{bandLabel(ws.band.target)}</strong>
                    {(ws.band.used.min !== ws.band.target.min || ws.band.used.max !== ws.band.target.max) && (
                      <>
                        {" "}
                        and then searched <strong>{bandLabel(ws.band.used)}</strong>
                      </>
                    )}
                    .
                  </span>
                </p>
              )}

              {keyMoves.length > 0 && (
                <div className="decided">
                  <span className="mini-h">What the agent decided on this run</span>
                  <ul>
                    {keyMoves.map((d) => (
                      <li key={d.id}>
                        <span className={`tag ${d.kind === "decision" ? "tag-decision" : "tag-notice"}`}>{d.kind === "decision" ? "Decision" : "Notice"}</span>
                        <span>
                          <strong>{d.label}</strong>
                          {d.detail && <span className="decided-detail"> {d.detail}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <article className="headliner" aria-label={`Headliner pick: ${headliner.name}`}>
                <span className="slot">Headliner</span>
                <h4 className="act-name">{headliner.name}</h4>
                <ActMeta p={headliner} />
                {headliner.shortDescription && <p className="act-desc">{headliner.shortDescription}</p>}
                <Why p={headliner} open />
              </article>

              {support.length > 0 && (
                <div className="support">
                  {support.map((p, i) => (
                    <article key={p.entityId} className="support-card" aria-label={`Support pick ${i + 1}: ${p.name}`}>
                      <span className="slot">Support {i + 1}</span>
                      <h4 className="act-name small">{p.name}</h4>
                      <ActMeta p={p} />
                      {p.shortDescription && <p className="act-desc">{p.shortDescription}</p>}
                      <Why p={p} />
                    </article>
                  ))}
                </div>
              )}

              {others.length > 0 && (
                <details className="others">
                  <summary>Also considered: {others.length} more acts</summary>
                  <ol className="others-list" start={4}>
                    {others.map((p) => (
                      <li key={p.entityId}>
                        <span className="others-name">{p.name}</span>
                        <span className={`verdict verdict-${p.drawFit ?? "unknown"}`} title={DRAW_FIT_TEXT[p.drawFit ?? "unknown"].long}>
                          {VERDICT[p.drawFit ?? "unknown"]}
                        </span>
                        <span className="others-score" title={`Qloo affinity ${pct(p.affinity)}/100, popularity ${pct(p.popularity)}/100`}>
                          {tasteWord(p.affinity)}
                        </span>
                      </li>
                    ))}
                  </ol>
                </details>
              )}

              {ws.explain && (
                <p className="explain-sum" title="Qloo feature.explainability: average influence of each past headliner on the recommendations">
                  <span className="mini-h">Which past headliners drove these picks</span> (Qloo explainability, {ws.explain.subset}):{" "}
                  {ws.explain.drivers.map((d) => (
                    <span key={d.entityId} className="chip chip-driver">
                      {d.name} {Math.round(d.score * 100)}%
                    </span>
                  ))}
                </p>
              )}
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

              <details className="glossary">
                <summary>How to read this</summary>
                <dl>
                  <dt>Taste match (Qloo affinity)</dt>
                  <dd>How strongly fans of your past headliners also like this act, on Qloo&apos;s 0-100 scale. Hover a match label to see the score.</dd>
                  <dt>Popularity and room size</dt>
                  <dd>
                    Qloo popularity is a 0-100 rank of how widely known an act is. Each room tier maps to a popularity range (a heuristic tuned on
                    real Qloo data). “In this room&apos;s tier” means the act&apos;s popularity sits inside that range, “Stretch pick” means it is more
                    widely known (likely pricier or a bigger room), “Below this room&apos;s tier” means less known. Popularity is a proxy for draw, not a
                    ticket forecast.
                  </dd>
                  <dt>Driven by (Qloo explainability)</dt>
                  <dd>Qloo reports which of your past headliners pulled each act into the results, and by how much.</dd>
                </dl>
              </details>
            </div>
          )}

          {ws && ws.heatmap.length > 0 && (
            <div className="card-block">
              <div className="card-head">
                <h3>Where this taste is concentrated {sample && <span className="badge badge-sample small">Recorded</span>}</h3>
                <p className="caption">
                  Qloo ranks areas of {ws.venue.city} by how much they like {ws.heatmapSubject.join(", ")}. Darker = stronger taste. This shows relative taste,
                  not fan counts.
                </p>
              </div>
              {conc && (
                <p className="stat-line">
                  <strong>{conc.verdict}.</strong> {conc.hotPct}% of the hottest areas are within {conc.km} km of{" "}
                  {ws.venue.custom ? "the city centre" : "the venue"}, vs {conc.allPct}% of all mapped areas.
                </p>
              )}
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
            </div>
          )}

          {ws && ws.demographics.length === 0 && ws.unavailable.includes("demographics") && (
            <div className="card-block">
              <h3>Who the fans are</h3>
              <p className="unavail-note" role="note">
                Unavailable on the hackathon key: Qloo answered 403 for audience demographics (urn:demographics), so age and gender skew is not shown. The
                rest of the plan and the pitch do not depend on it.
                {ws.venue.simulate === "403" && " (Simulated 403 in recorded mode.)"}
              </p>
            </div>
          )}

          {ws && ws.demographics.length > 0 && (
            <div className="card-block">
              <div className="card-head">
                <h3>Who the fans are {sample && <span className="badge badge-sample small">Recorded</span>}</h3>
                <p className="caption">
                  Age and gender lean of each act&apos;s fans compared with the average Qloo user. Bars right of the line = more likely than average, left =
                  less. Useful for marketing and sponsor fit.
                </p>
              </div>
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
            </div>
          )}

          {ws && (ws.brands.length > 0 || ws.places.length > 0) && (
            <div className="card-block">
              <div className="card-head">
                <h3>Sponsors and local partners {sample && <span className="badge badge-sample small">Recorded</span>}</h3>
                <p className="caption">Brands and nearby places this crowd likes, per Qloo. A starting list for sponsorship and pre-show partners.</p>
              </div>
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
              </div>
              <p className="fineprint">Numbers are Qloo taste-match scores (0-100) with this crowd.</p>
            </div>
          )}

          {ws?.pitch && (
            <article className="card-block pitch" aria-labelledby="pitch-h">
              <div className="pitch-head">
                <div>
                  <h3 id="pitch-h">Booking pitch, ready to send</h3>
                  <p className="caption">A one-pager for the artist&apos;s agent or your partners, built from the results above.</p>
                </div>
                <div className="pitch-actions">
                  <button onClick={download}>Download .md</button>
                  <button onClick={() => window.print()}>Print / PDF</button>
                </div>
              </div>
              {sample && <p className="pitch-warn">Built from recorded Qloo responses ({meta.recordedOn ?? "earlier run"}), not a live call. Re-run live before sending.</p>}
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
                  Data: Qloo Insights API{sample ? `, ${recLabel.replace("Recorded from the Qloo API", "recorded")}` : ", live"}. Text:{" "}
                  {ws.pitch.author === "llm" ? `written by ${meta.llm.label} from the Qloo results` : "deterministic template"}. Affinity scores describe
                  correlations in taste, not predictions about individuals or ticket sales.
                </p>
              </div>
            </article>
          )}
        </section>
      </div>
      <footer className="foot">
        Lineup Architect, built for the Qloo Agentic Hackathon. Taste data from Qloo. Map tiles &copy; OpenStreetMap contributors.
      </footer>
    </div>
  );
}

function ActMeta({ p }: { p: ArtistPick }) {
  const fit = p.drawFit ?? "unknown";
  return (
    <div className="act-meta">
      <span className={`verdict verdict-${fit}`} title={DRAW_FIT_TEXT[fit].long}>
        {VERDICT[fit]}
      </span>
      <span className="match" title={`Qloo affinity ${pct(p.affinity)}/100: how strongly fans of your past headliners like this act`}>
        <span className="match-word">{tasteWord(p.affinity)}</span>
        <span className="meter" aria-hidden="true">
          <span style={{ width: `${pct(p.affinity)}%` }} />
        </span>
        <span className="match-num">{pct(p.affinity)}</span>
      </span>
      <span className="pop" title="Qloo popularity: 0-100 rank of how widely known the act is">
        Popularity {pct(p.popularity)}
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
