# Built during the Qloo Agentic Hackathon

Submission period opened 2026-09-30 09:00 ET. Everything in this repository was
created during the hackathon; no pre-existing project code was reused.

Scaffold: `create-next-app` (Next.js 16.3.8, TypeScript, App Router) on 2026-10-02.
Third-party libraries: next, react, leaflet, @anthropic-ai/sdk, server-only (see package.json).
Development was AI-assisted (Claude Code); disclosure wording to be finalised by the team.

| Date (UTC) | Commit | What was built |
|---|---|---|
| 2026-10-03 | 2fb1437 | Vertical slice: server-only Qloo client (/search, /v2/tags, /v2/insights incl. heatmap and demographics) with in-memory cache; labelled sample fixtures (`scripts/make-fixtures.mjs`); agent tools; Claude Haiku 4.5 tool-use provider plus deterministic scripted planner; NDJSON streaming route; UI with venue picker, live trace, ranked act cards, Leaflet affinity map, audience skew, sponsor and partner lists, pitch one-pager (Markdown and print); README, MIT LICENSE, .env.example |
