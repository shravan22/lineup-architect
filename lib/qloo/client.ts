import "server-only";
import type { DataSource, QlooMode } from "@/lib/types";
import { cacheGet, cacheKey, cacheSet } from "./cache";
import { fixtureFor, recordedSubject } from "./fixtures";
import { trimResponse } from "./trim";

// Server-only Qloo client for the hackathon API.
// - Base URL: https://hackathon.api.qloo.com (hackathon keys only work here)
// - Auth: X-Api-Key header, read from process.env.QLOO_API_KEY. Never sent to the browser.
// - Endpoints used: /search, /v2/tags, /v2/insights (GET, query params only).
// - Docs (checked 2026-10-05, notes/qloo-docs-review.md):
//   https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide
//   401 = wrong base URL or header, 403 = entity type not enabled, 400 = bad
//   params (e.g. a location query that matches no locality), /search 404 = no hits.
// - With no key (or QLOO_MODE=fixture) preset calls are answered from responses
//   recorded from this API (fixtures/*.json, scripts/record-fixtures.mjs).
// - Rate limit (response headers, 2026-10-06): 5 requests/second, 10,000/month.

const BASE_URL = process.env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com";
// One cold insights call took 28 s on 2026-10-06; most take 0.3-3 s.
const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 2; // bounded retries, per the hackathon kit guidance
// The key allows 5 requests per second; space request starts to stay under it.
const MIN_GAP_MS = 220;
let nextSlot = 0;

async function throttle() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

export function qlooMode(): QlooMode {
  if (process.env.QLOO_MODE === "fixture") return "fixture";
  return process.env.QLOO_API_KEY ? "live" : "fixture";
}

export class QlooError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export interface QlooResult<T = unknown> {
  data: T;
  source: DataSource;
  endpoint: string;
  /** Recorded mode only: the acts the replayed call was recorded for, when they differ from the request. */
  standIn?: { ids: string[]; names: string[] };
}

type Params = Record<string, string | number | undefined>;

function clean(params: Params): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") out[k] = String(v);
  }
  return out;
}

const HINTS: Record<number, string> = {
  401: " (key rejected: hackathon keys only work on hackathon.api.qloo.com with the X-Api-Key header)",
  403: " (this entity type is not enabled for the key)",
  400: " (bad request: check parameter values, e.g. the location query)",
  429: " (rate limited)",
};

async function liveGet(pathname: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(pathname, BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await throttle();
      const res = await fetch(url, {
        method: "GET",
        headers: { "X-Api-Key": process.env.QLOO_API_KEY ?? "", accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
      if (res.ok) return await res.json();
      // /search documents 404 as "No results": treat it as an empty hit list.
      if (res.status === 404 && pathname === "/search") return { success: true, results: [] };
      // Do not echo the response body: it could contain request details.
      lastErr = new QlooError(`Qloo ${pathname} returned HTTP ${res.status}${HINTS[res.status] ?? ""}`, res.status);
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      lastErr = e;
    }
    // 429: the per-second window resets after 1 s.
    const wait = lastErr instanceof QlooError && lastErr.status === 429 ? 1100 : 600 * attempt;
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, wait));
  }
  throw lastErr instanceof Error ? lastErr : new QlooError(String(lastErr));
}

/** Which labelled sample fixture set answers calls in fixture mode (preset venues only). */
export interface QlooCtx {
  fixtureSet?: string;
  /**
   * Sample mode only: filter.type values to answer with a simulated HTTP 403, as a
   * hackathon key that lacks that entity type would (e.g. urn:demographics, urn:tag).
   * Ignored in live mode.
   */
  simulateDenied?: string[];
  /** Sample mode only: drop query.explainability from responses. */
  simulateNoExplain?: boolean;
}

/** Filter types denied in sample mode via QLOO_FIXTURE_DENY (comma list), for testing. */
export function envDenied(): string[] {
  return (process.env.QLOO_FIXTURE_DENY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export async function qlooGet<T = unknown>(pathname: string, rawParams: Params, ctx: QlooCtx = {}): Promise<QlooResult<T>> {
  const params = clean(rawParams);
  const key = cacheKey(pathname, params);
  const endpoint = `GET ${pathname}`;

  if (qlooMode() === "fixture") {
    const denied = [...envDenied(), ...(ctx.simulateDenied ?? [])];
    if (pathname === "/v2/insights" && params["filter.type"] && denied.includes(params["filter.type"])) {
      throw new QlooError(`Qloo ${pathname} returned HTTP 403${HINTS[403]} [simulated in sample mode]`, 403);
    }
    const data = fixtureFor(ctx.fixtureSet, pathname, params, { noExplain: ctx.simulateNoExplain });
    if (data === null) {
      throw new QlooError(
        "No sample data for this request. Sample mode only covers the five preset venues; add a Qloo API key for live data.",
      );
    }
    return { data: data as T, source: "fixture", endpoint, standIn: recordedSubject(ctx.fixtureSet, pathname, params) };
  }

  const cached = await cacheGet(key);
  if (cached !== undefined) return { data: cached as T, source: "cache", endpoint };

  try {
    const data = trimResponse(pathname, await liveGet(pathname, params));
    await cacheSet(key, data);
    if (process.env.QLOO_RECORD_DIR) await record(ctx.fixtureSet ?? "custom", key, data);
    return { data: data as T, source: "live", endpoint };
  } catch (e) {
    const stale = await cacheGet(key, true);
    if (stale !== undefined) return { data: stale as T, source: "cache", endpoint };
    throw e;
  }
}

/**
 * Dev-only recorder (QLOO_RECORD_DIR set): appends each trimmed live response to
 * <dir>/<fixtureSet>.ndjson. scripts/record-fixtures.mjs turns these into fixtures.
 * Only the request path + params and the response body are written, never headers.
 */
async function record(set: string, key: string, data: unknown) {
  try {
    const { appendFile, mkdir } = await import("node:fs/promises");
    const dir = process.env.QLOO_RECORD_DIR!;
    await mkdir(dir, { recursive: true });
    await appendFile(`${dir}/${set.replace(/[^a-z0-9-]/gi, "_")}.ndjson`, `${JSON.stringify({ key, data })}\n`);
  } catch {
    // recording is best-effort
  }
}

// ---- Thin typed wrappers ----

export const qloo = {
  search: (query: string, type = "urn:entity:artist", take = 3, ctx?: QlooCtx) =>
    qlooGet("/search", { query, types: type, take }, ctx),

  // filter.tag.types=urn:tag:genre:music keeps the lookup to music genres (the tag
  // type artists carry, per https://docs.qloo.com/reference/schema-taxonomy).
  tags: (query: string, take = 5, ctx?: QlooCtx, tagType: string | undefined = "urn:tag:genre:music") =>
    qlooGet("/v2/tags", { "filter.query": query, "filter.parents.types": "urn:entity:artist", "filter.tag.types": tagType, take }, ctx),

  insights: (params: Params, ctx?: QlooCtx) => qlooGet("/v2/insights", params, ctx),
};
