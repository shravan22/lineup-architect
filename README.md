# Lineup Architect

A venue-first booking agent for independent venues and small festivals, built for the
[Qloo Agentic Hackathon](https://qloo.devpost.com/). Start from a room, not an artist: pick
one of five preset venues, or enter your own (name, city, capacity, 1-3 past headliners).
An agent plans and calls Qloo taste-data tools and asks "who does this crowd already like",
across music, brands, places and demographics. It returns:

1. Ranked candidate acts with Qloo affinity, shared taste tags, Qloo explainability ("driven
   by" which past headliner) and a room-tier verdict (in this room's tier / stretch pick /
   below this room's tier). The verdict compares Qloo popularity with a capacity-based range.
   That range is a heuristic, and popularity is only a proxy for draw: the app does not
   forecast ticket sales or attendance.
2. A Leaflet map of where in the city the taste is concentrated (Qloo heatmap), with a
   plain reading of whether hot areas cluster near the venue or spread across the city
3. An audience profile (age and gender skew from Qloo demographics)
4. A sponsor-brand shortlist and local partner spots (bars, music venues, record stores,
   cafes, galleries) from cross-domain Qloo insights
5. A booking pitch one-pager (download as Markdown or print to PDF)

> Status: working slice. Live Qloo calls verified against the hackathon API (all 5 presets
> and a custom venue). The Gemini planner (`gemini-3.5-flash-lite`) has been run live; the
> Claude planner is wired through the same interface. Every run is labelled with the data
> mode and the planner actually used.

## How it works

- `lib/qloo/client.ts`: server-only Qloo client for `https://hackathon.api.qloo.com`
  (`/search`, `/v2/tags`, `/v2/insights` incl. `filter.type=urn:heatmap` and
  `urn:demographics`). The `X-Api-Key` header is read from `QLOO_API_KEY` on the
  server and never reaches the browser. Live responses go through a pluggable
  cache (`lib/qloo/cache.ts`, in-memory, per server instance). A stale entry is
  served if the API fails, but a cold serverless instance starts with an empty cache.
- `lib/agent/`: tool definitions (`tools.ts`), a provider-agnostic LLM interface
  (`llm.ts`) and the agent loop (`run.ts`). Agent steps stream to the UI as NDJSON
  from `POST /api/agent`.
- The agent makes visible decisions, shown in "What the agent decided":
  - It disambiguates headliners when Qloo /search returns several plausible artists.
  - It sets the popularity band (`filter.popularity.min/max`). The first search looks a
    little above the room's ceiling, so stretch picks are visible. If stretch acts crowd
    out in-tier acts, the agent caps the search at the ceiling. The two strongest stretch
    picks stay on the list as labelled reach options. If too few acts sit at or below the
    ceiling, it widens the band downwards. A re-query that adds fewer than 2 new acts is
    reverted and logged as "kept", so a band change in the trace always changed the list.
- Independent tool calls run in parallel. The LLM loop is capped at 8 turns. A 50 s time
  budget (under Vercel's 60 s limit) streams partial results with a template pitch if it
  runs out (`AGENT_BUDGET_MS`).
- Qloo facts are stored in a structured workspace that the UI renders. The LLM only
  decides the plan and writes the pitch narrative. Its pitch is checked against the data
  before it is shown. It is rejected if it promises outcomes (attendance, sales,
  sell-outs, guarantees), or claims local concentration when the heatmap does not show it
  (hot-cell lift of 1.1 or less), or calls a stretch act a fit for the room. A rejected
  pitch is replaced by the data-only template, and the trace and the pitch say so.
- Partner spots are filtered on Qloo place tags to music-relevant categories. Spots
  such as clinics, tattoo shops and hotels are dropped, and the trace lists them.

## Modes (always labelled in the UI)

Qloo data:

| Condition | Qloo data |
|---|---|
| `QLOO_API_KEY` set (and `QLOO_MODE` not `fixture`) | Live Qloo API. The badge says "Live Qloo API". Repeat calls within 24 h come from the server cache and are marked `cache` in the trace. |
| no `QLOO_API_KEY`, or `QLOO_MODE=fixture` | Recorded mode. The badge says "Recorded from the Qloo API on <date>". These are real responses recorded from the hackathon API, trimmed to the fields the app reads and replayed per request. Only the five preset venues are covered. A custom venue shows a "needs a live Qloo key" state with the plan it would run, instead of invented results. |

Planner (`lib/agent/llm.ts` `selectProvider`):

| Condition | Planner |
|---|---|
| `LLM_PROVIDER=gemini` / `claude` / `scripted` | That provider. Gemini and Claude also need their key; without it the scripted planner runs. |
| `LLM_PROVIDER` unset, `ANTHROPIC_API_KEY` set | Claude (`claude-haiku-4-5-20251001`) via Anthropic tool use |
| `LLM_PROVIDER` unset, no Anthropic key, `GEMINI_API_KEY` set | Gemini (`gemini-3.5-flash-lite`) via `@google/genai` function calling |
| no LLM key | Rule-based scripted planner: the same tools and branch logic (disambiguate, cap or widen the band), deterministic, labelled "rule-based" |

If the LLM fails, hits a quota (HTTP 429) or is too slow for the time budget, the scripted
planner finishes the same run. The badge switches to "rule-based fallback" and a notice gives
the reason.

## Environment variables

| Variable | Purpose |
|---|---|
| `QLOO_API_KEY` | Qloo hackathon key (server only). Without it the app runs in recorded mode. |
| `QLOO_MODE` | `fixture` forces recorded mode even when a key is set |
| `QLOO_BASE_URL` | Override the API base (default `https://hackathon.api.qloo.com`) |
| `QLOO_CACHE_TTL_MS` | Live response cache lifetime (default 24 h) |
| `LLM_PROVIDER` | `gemini`, `claude` or `scripted` (optional, see above) |
| `ANTHROPIC_API_KEY` | Enables the Claude planner |
| `GEMINI_API_KEY` | Enables the Gemini planner |
| `LLM_MODEL` | Model override for the selected provider |
| `GEMINI_THINKING` | Gemini thinking level (default `low`) |
| `AGENT_BUDGET_MS` | Total time budget per run (default 50000) |

Re-record the fixtures: build, start with `QLOO_RECORD_DIR=.recordings` and a key, run each
preset once, then `node scripts/record-fixtures.mjs` (one file per preset in `fixtures/`; the
script refuses to write header- or key-like strings). Live API facts: rate limit 5/s and
10,000/month. `signal.interests.tags` is slow, so it is not used.

## Run locally

```sh
npm install
cp .env.example .env.local   # optional: add keys
npm run dev                  # http://localhost:3000
```

Deploys to Vercel with no file-system writes at runtime.

## Responsible use

No personal data is sent to Qloo. Affinity scores describe correlations in taste, not
predictions about individuals. Popularity tiers are a heuristic for draw, not a ticket
forecast.

## License

MIT, see [LICENSE](LICENSE).
