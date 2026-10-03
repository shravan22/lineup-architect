import "server-only";

// In-memory cache for live Qloo responses (Vercel-safe: no file-system writes).
// Entries live for the life of the server instance. Stale entries are still
// returned when the live API fails, so the demo survives quota or network
// problems. For cold starts, demo-path responses can be recorded into
// /fixtures and bundled (see README).

const TTL_MS = Number(process.env.QLOO_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000);
const MAX_ENTRIES = 500;

interface Entry {
  storedAt: number;
  data: unknown;
}

const memory = new Map<string, Entry>();

export function cacheKey(pathname: string, params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return `${pathname}?${sorted}`;
}

export function cacheGet(key: string, allowStale = false): unknown | undefined {
  const entry = memory.get(key);
  if (!entry) return undefined;
  if (!allowStale && Date.now() - entry.storedAt > TTL_MS) return undefined;
  return entry.data;
}

export function cacheSet(key: string, data: unknown): void {
  if (memory.size >= MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, { storedAt: Date.now(), data });
}
