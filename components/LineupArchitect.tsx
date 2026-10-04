"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState } from "react";
import { bandLabel, capacityBand, DRAW_FIT_TEXT } from "@/lib/band";
import { CITIES, OTHER_CITY } from "@/lib/cities";
import type { AgentEvent, CustomVenueRequest, DataSource, StatusInfo, VenueInput, Workspace } from "@/lib/types";
import { pitchMarkdown } from "@/lib/pitch";

const AffinityMap = dynamic(() => import("./AffinityMap"), {
  ssr: false,
  loading: () => <div className="map map-loading">Loading map...</div>,
});

interface Step {
  id: string;
  kind: "tool" | "thought" | "notice" | "decision";
  label: string;
  detail?: string;
  status: "running" | "ok" | "error" | "info";
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
  const abortRef = useRef<AbortController | null>(null);

  const isCustom = venueId === CUSTOM;
  const venue = venues.find((v) => v.id === venueId);
  const sample = meta.qlooMode === "fixture";

  const handle = useCallback((e: AgentEvent) => {
    switch (e.type) {
      case "meta":
        setMeta({ qlooMode: e.qlooMode, llm: e.llm });
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
            x.id === e.id ? { ...x, status: e.ok ? "ok" : "error", detail: e.summary, ms: e.ms, sources: e.sources, endpoints: e.endpoints } : x,
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
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setSteps([]);
    setWs(null);
    setError(null);
    setNeedsLive(null);
    setPartial(false);
    setElapsed(null);
    setRunState("running");
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

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">LA</span>
          <div>
            <h1>Lineup Architect</h1>
            <p className="tagline">A booking agent for independent venues, powered by Qloo taste data</p>
          </div>
        </div>
        <div className="badges" aria-label="Data and agent mode">
          {sample ? (
            <span className="badge badge-sample" title="No Qloo API key configured: preset results come from hand-written sample fixtures, not live Qloo data.">
              Sample data
            </span>
          ) : (
            <span className="badge badge-live">Live Qloo data</span>
          )}
          <span className={`badge ${meta.llm.provider === "scripted" ? "badge-scripted" : "badge-llm"}`} title="Which planner drives the tool calls">
            {meta.llm.label}
          </span>
        </div>
      </header>

      {sample && (
        <p className="banner" role="note">
          <strong>Sample data mode.</strong> No Qloo API key is configured, so every score, map cell and brand for the preset venues
          comes from illustrative fixtures in the documented Qloo response format. They are not real Qloo results. Your own venue
          needs a live key.
        </p>
      )}

      <main className="layout">
        <section className="panel setup" aria-labelledby="setup-h">
          <h2 id="setup-h">1. Pick a venue</h2>
          <fieldset className="venues">
            <legend className="sr-only">Venues</legend>
            {venues.map((v) => (
              <label key={v.id} className={`venue ${v.id === venueId ? "selected" : ""}`}>
                <input type="radio" name="venue" value={v.id} checked={v.id === venueId} onChange={() => setVenueId(v.id)} />
                <span className="venue-name">
                  {v.name} <small>{v.city} / {v.capacity} cap / {v.genreHint}</small>
                </span>
                {v.id === venueId && (
                  <>
                    <span className="venue-blurb">{v.blurb}</span>
                    <span className="venue-heads">
                      Past headliners: <strong>{v.headliners.join(", ")}</strong>
                    </span>
                  </>
                )}
              </label>
            ))}
            <label className={`venue venue-custom ${isCustom ? "selected" : ""}`}>
              <input type="radio" name="venue" value={CUSTOM} checked={isCustom} onChange={() => setVenueId(CUSTOM)} />
              <span className="venue-name">
                Your venue <small>any city, capacity and past headliners{sample ? " (needs a live Qloo key)" : ""}</small>
              </span>
            </label>
          </fieldset>

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
                <legend>Past headliners (1-3)</legend>
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
                {form.capacity >= 50 ? `A ${form.capacity}-cap room targets Qloo popularity ${bandLabel(formBand)}.` : ""} The agent widens or narrows that band
                if too few or too many acts fit.
              </p>
              {formError && (
                <p className="error" role="alert">
                  {formError}
                </p>
              )}
            </form>
          )}

          <button className="run" onClick={run} disabled={runState === "running" || (!venue && !isCustom)}>
            {runState === "running"
              ? "Agent working..."
              : isCustom
                ? sample
                  ? "Plan with live Qloo data"
                  : "Plan the next booking"
                : runState === "idle"
                  ? "Plan the next booking"
                  : "Run again"}
          </button>

          <h2 id="trace-h">2. Agent trace</h2>
          <div aria-live="polite" aria-labelledby="trace-h">
            {runState === "idle" && <p className="empty">Press the button to watch the agent plan its Qloo calls and make its booking decisions.</p>}
            <ol className="trace">
              {steps.map((s) => (
                <li key={s.id} className={`step step-${s.kind} step-${s.status}`}>
                  {s.kind === "tool" ? (
                    <>
                      <span className="step-icon" aria-hidden="true">
                        {s.status === "running" ? <span className="spinner" /> : s.status === "ok" ? "✓" : "!"}
                      </span>
                      <div>
                        <div className="step-label">
                          {s.label}
                          {s.ms !== undefined && <span className="ms">{s.ms} ms</span>}
                          {s.sources?.map((src, i) => (
                            <span key={i} className={`src src-${src}`}>
                              {src === "fixture" ? "sample" : src}
                            </span>
                          ))}
                        </div>
                        {s.detail && <div className="step-detail">{s.detail}</div>}
                        {s.endpoints && s.endpoints.length > 0 && <div className="step-endpoint">{s.endpoints.join(", ")}</div>}
                      </div>
                    </>
                  ) : s.kind === "decision" ? (
                    <div className="decision">
                      <div className="decision-head">
                        <span className="decision-tag">Decision</span>
                        <span className="decision-by">{s.by === "llm" ? "by the LLM agent" : "by the scripted planner"}</span>
                      </div>
                      <div className="decision-title">{s.label}</div>
                      {s.detail && <div className="decision-detail">{s.detail}</div>}
                    </div>
                  ) : (
                    <p className="thought">
                      <span className="who">{s.kind === "notice" ? "Notice" : s.by === "llm" ? "Agent" : "Planner"}:</span> {s.label}
                    </p>
                  )}
                </li>
              ))}
            </ol>
            {runState === "running" && steps.length === 0 && <p className="empty">Starting agent...</p>}
            {runState === "done" && elapsed !== null && !needsLive && (
              <p className="hint">
                Finished in {(elapsed / 1000).toFixed(1)} s{partial ? " (partial: time budget reached)" : ""}.
              </p>
            )}
            {error && (
              <p className="error" role="alert">
                {error} <button onClick={run}>Retry</button>
              </p>
            )}
          </div>
        </section>

        <section className="results" aria-labelledby="results-h">
          <h2 id="results-h" className="sr-only">Results</h2>

          {needsLive && (
            <div className="panel needs-live" role="status">
              <h3>Needs a live Qloo key</h3>
              <p>{needsLive.text}</p>
              <p className="sub">With a key, the agent would run these steps for your venue:</p>
              <ol className="plan">
                {needsLive.plan.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ol>
              <p className="sub">Meanwhile, try one of the five presets to see the full flow on labelled sample data.</p>
            </div>
          )}

          {partial && ws && (
            <p className="banner partial" role="note">
              <strong>Partial result.</strong> The agent hit its time budget before every step finished. What is shown is complete for
              each section that has data; the pitch is a template.
            </p>
          )}

          {!needsLive && !ws?.picks.length && (
            <div className="panel placeholder">
              {runState === "running" ? (
                <>
                  <div className="skeleton" />
                  <div className="skeleton" />
                  <div className="skeleton short" />
                </>
              ) : runState === "done" ? (
                <p className="empty">The agent finished without candidates. Check the trace for errors.</p>
              ) : (
                <p className="empty">Ranked acts with a draw-fit check, the affinity map, the audience profile, sponsors and the pitch will appear here.</p>
              )}
            </div>
          )}

          {ws && ws.picks.length > 0 && (
            <div className="panel">
              <h3>Ranked acts {sample && <span className="badge badge-sample small">Sample</span>}</h3>
              {ws.band && (
                <p className="band" title="Qloo popularity is a 0-100 percentile. The capacity-to-band mapping is a heuristic.">
                  {ws.venue.capacity}-cap room: target popularity <strong>{bandLabel(ws.band.target)}</strong>
                  {(ws.band.used.min !== ws.band.target.min || ws.band.used.max !== ws.band.target.max) && (
                    <>
                      , agent searched <strong>{bandLabel(ws.band.used)}</strong>
                    </>
                  )}
                  . Queries: {ws.band.history.join("; ")}. Acts that fit the room are listed first.
                </p>
              )}
              {ws.tasteTags.length > 0 && (
                <p className="taste">
                  Venue taste profile:{" "}
                  {ws.tasteTags.slice(0, 6).map((t) => (
                    <span key={t.id} className="chip">
                      {t.name}
                    </span>
                  ))}
                </p>
              )}
              <ol className="cards">
                {ws.picks.map((p, i) => (
                  <li key={p.entityId} className="card">
                    <span className="rank">#{i + 1}</span>
                    <div className="card-body">
                      <div className="card-name">
                        {p.name}
                        {p.drawFit && (
                          <span className={`fit fit-${p.drawFit}`} title={DRAW_FIT_TEXT[p.drawFit].long}>
                            {DRAW_FIT_TEXT[p.drawFit].short}
                          </span>
                        )}
                      </div>
                      {p.shortDescription && <div className="card-desc">{p.shortDescription}</div>}
                      <div className="meter" aria-label={`Affinity ${pct(p.affinity)} out of 100`}>
                        <span style={{ width: `${pct(p.affinity)}%` }} />
                      </div>
                      <div className="card-stats">
                        <span>
                          Affinity <strong>{pct(p.affinity)}</strong>
                        </span>
                        <span>Popularity {pct(p.popularity)}</span>
                      </div>
                      {p.sharedTags.length > 0 && <div className="card-tags">Shares: {p.sharedTags.join(", ")}</div>}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {ws && ws.heatmap.length > 0 && (
            <div className="panel">
              <h3>
                Where the crowd is {sample && <span className="badge badge-sample small">Sample</span>}
              </h3>
              <p className="sub">Local taste affinity for {ws.heatmapSubject.join(", ")} around {ws.venue.city}.</p>
              <AffinityMap venue={ws.venue} points={ws.heatmap} places={ws.places} />
              <div className="legend" aria-hidden="true">
                <span><i style={{ background: "#fee08b" }} />&lt;60</span>
                <span><i style={{ background: "#fdae61" }} />60</span>
                <span><i style={{ background: "#f46d43" }} />70</span>
                <span><i style={{ background: "#d73027" }} />80</span>
                <span><i style={{ background: "#a50026" }} />90+</span>
                <span><i className="dot venue-dot" />Venue</span>
                <span><i className="dot place-dot" />Partner spot</span>
              </div>
            </div>
          )}

          {ws && ws.demographics.length > 0 && (
            <div className="panel">
              <h3>Audience profile {sample && <span className="badge badge-sample small">Sample</span>}</h3>
              <p className="sub">Age and gender skew of fans compared with the average Qloo audience (0 = average).</p>
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
            <div className="panel two-col">
              <div>
                <h3>Sponsor shortlist {sample && <span className="badge badge-sample small">Sample</span>}</h3>
                <ol className="list">
                  {ws.brands.map((b) => (
                    <li key={b.entityId}>
                      <span>
                        <strong>{b.name}</strong> <small>{b.category}</small>
                      </span>
                      <span className="score">{pct(b.affinity)}</span>
                    </li>
                  ))}
                </ol>
              </div>
              <div>
                <h3>Local partner spots {sample && <span className="badge badge-sample small">Sample</span>}</h3>
                <ol className="list">
                  {ws.places.map((p) => (
                    <li key={p.entityId}>
                      <span>
                        <strong>{p.name}</strong> <small>{p.category}</small>
                      </span>
                      <span className="score">{pct(p.affinity)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}

          {ws?.pitch && (
            <article className="panel pitch" aria-labelledby="pitch-h">
              <div className="pitch-head">
                <h3 id="pitch-h">Booking pitch</h3>
                <div className="pitch-actions">
                  <button onClick={download}>Download .md</button>
                  <button onClick={() => window.print()}>Print / PDF</button>
                </div>
              </div>
              {sample && <p className="pitch-warn">Built from SAMPLE data. Do not send.</p>}
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
                Data: Qloo {sample ? "(sample fixtures)" : "Insights API"}. Text:{" "}
                {ws.pitch.author === "llm" ? `written by ${meta.llm.label} from the Qloo results` : "deterministic template"}. Affinity
                scores describe correlations in taste, not predictions about individuals.
              </p>
            </article>
          )}
        </section>
      </main>
      <footer className="foot">
        Lineup Architect, built for the Qloo Agentic Hackathon. Taste data from Qloo. Map tiles &copy; OpenStreetMap contributors.
      </footer>
    </div>
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
        {Math.round(v * 100)}%
      </td>
    </tr>
  );
}
