import "server-only";
import type { DataSource, QlooMode } from "@/lib/types";
import { cacheGet, cacheKey, cacheSet } from "./cache";
import { fixtureFor } from "./fixtures";

// Server-only Qloo client for the hackathon API.
// - Base URL: https://hackathon.api.qloo.com (hackathon keys only work here)
// - Auth: X-Api-Key header, read from process.env.QLOO_API_KEY. Never sent to the browser.
// - Endpoints used: /search, /v2/tags, /v2/insights (GET, query params only).
// - Docs (checked 2026-10-05, notes/qloo-docs-review.md):
//   https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide
//   401 = wrong base URL or header, 403 = entity type not enabled, 400 = bad
//   params (e.g. a location query that matches no locality), /search 404 = no hits.
// - With no key (or QLOO_MODE=fixture) every call is answered from SAMPLE fixtures.

const BASE_URL = process.env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com";
const TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 2; // bounded retries, per the hackathon kit guidance

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
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 600 * attempt));
  }
  throw lastErr instanceof Error ? lastErr : new QlooError(String(lastErr));
}

/** Which labelled sample fixture set answers calls in fixture mode (preset venues only). */
export interface QlooCtx {
  fixtureSet?: string;
}

export async function qlooGet<T = unknown>(pathname: string, rawParams: Params, ctx: QlooCtx = {}): Promise<QlooResult<T>> {
  const params = clean(rawParams);
  const key = cacheKey(pathname, params);
  const endpoint = `GET ${pathname}`;

  if (qlooMode() === "fixture") {
    const data = fixtureFor(ctx.fixtureSet, pathname, params);
    if (data === null) {
      throw new QlooError(
        "No sample data for this request. Sample mode only covers the five preset venues; add a Qloo API key for live data.",
      );
    }
    return { data: data as T, source: "fixture", endpoint };
  }

  const cached = await cacheGet(key);
  if (cached !== undefined) return { data: cached as T, source: "cache", endpoint };

  try {
    const data = await liveGet(pathname, params);
    await cacheSet(key, data);
    return { data: data as T, source: "live", endpoint };
  } catch (e) {
    const stale = await cacheGet(key, true);
    if (stale !== undefined) return { data: stale as T, source: "cache", endpoint };
    throw e;
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
