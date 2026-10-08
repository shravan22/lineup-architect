# Lineup Architect

An AI booking agent for independent venues and small festivals, built for the
[Qloo Agentic Hackathon](https://qloo.devpost.com/). Pick one of five preset
venues, or enter your own (name, city, capacity, 1-3 past headliners). The agent
plans and calls Qloo taste-data tools, then returns:

1. Ranked candidate acts with Qloo affinity scores, shared taste tags and a
   draw-fit badge (fits the room / stretch / under-draw) from a capacity-based
   Qloo popularity band
2. A Leaflet map of local taste affinity (Qloo heatmap) around the venue
3. An audience profile (age and gender skew from Qloo demographics)
4. A sponsor-brand shortlist and local partner spots (cross-domain Qloo insights)
5. A booking pitch one-pager (download as Markdown or print to PDF)

> Status: vertical slice. Live Qloo calls verified against the hackathon API on
> 2026-10-07 (all 5 presets and a custom venue). The Claude planner is wired but
> untested until an Anthropic key arrives. Without a Qloo key the presets replay
> responses recorded from the Qloo API (see below).

## How it works

- `lib/qloo/client.ts`: server-only Qloo client for `https://hackathon.api.qloo.com`
  (`/search`, `/v2/tags`, `/v2/insights` incl. `filter.type=urn:heatmap` and
  `urn:demographics`). The `X-Api-Key` header is read from `QLOO_API_KEY` on the
  server and never reaches the browser. Live responses go through a pluggable
  cache (`lib/qloo/cache.ts`, in-memory today, per server instance; a Vercel KV
  store can implement the same interface). A stale entry is served if the API
  fails, but a cold serverless instance starts with an empty cache.
- `lib/agent/`: tool definitions, a provider-agnostic LLM interface, and the agent
  loop. The real provider is Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) via
  `@anthropic-ai/sdk` tool use. Agent steps stream to the UI as NDJSON from
  `POST /api/agent`.
- The agent makes visible decisions: it disambiguates headliners when Qloo
  /search returns several plausible artists, and widens or narrows the
  popularity band (`filter.popularity.min/max`) when too few or too many acts
  fit the room. Independent tool calls run in parallel, the LLM loop is capped at
  8 turns, and a 50 s time budget (under Vercel's 60 s limit) streams partial
  results with a template pitch if it runs out (`AGENT_BUDGET_MS`).
- Qloo facts are stored in a structured workspace that the UI renders; the LLM only
  writes the pitch narrative, so data and interpretation stay separate.

## Modes (always labelled in the UI)

| Condition | Qloo data | Planner |
|---|---|---|
| `QLOO_API_KEY` set (default when present) | Live (badge "Live Qloo API"; repeat calls within 24 h come from the server cache and are marked `cache` in the trace) | |
| no `QLOO_API_KEY`, or `QLOO_MODE=fixture` | Badge "Recorded from the Qloo API on <date>": real responses recorded from the hackathon API, trimmed to the fields the app reads, replayed per request. Only the five preset venues are covered; a custom venue shows a "needs a live Qloo key" state instead of results. | |
| `ANTHROPIC_API_KEY` set | | Claude tool-use agent |
| no `ANTHROPIC_API_KEY` | | Scripted planner: same branch logic (disambiguate, widen/narrow band), deterministic, labelled |

Re-record the fixtures: build, start with `QLOO_RECORD_DIR=.recordings` and a key, run each
preset once, then `node scripts/record-fixtures.mjs` (one file per preset in `fixtures/`; the
script refuses to write header- or key-like strings). Live API facts:
rate limit 5/s and 10,000/month; `signal.interests.tags` is slow, so it is not used).

## Run locally

```sh
npm install
cp .env.example .env.local   # optional: add keys
npm run dev                  # http://localhost:3000
```

Deploys to Vercel with no file-system writes at runtime.

## Responsible use

No personal data is sent to Qloo. Affinity scores describe correlations in taste,
not predictions about individuals.

## License

MIT, see [LICENSE](LICENSE).
