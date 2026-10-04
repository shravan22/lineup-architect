import "server-only";

// Pluggable cache for live Qloo responses.
//
// Today only the in-memory store exists. Entries live for the life of one
// server instance, so on Vercel a cold start begins empty (the protection is
// per-instance, not global). Stale entries are still returned when the live API
// fails.
//
// To persist across instances later (e.g. Vercel KV / Upstash Redis), add a
// store that implements CacheStore with the provider's get/set, and return it
// from cacheStore() when its env vars are present. Nothing else needs to change:
// the client only talks to this interface.

export interface CacheEntry {
  storedAt: number;
  data: unknown;
}

export interface CacheStore {
  readonly name: string;
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

const TTL_MS = Number(process.env.QLOO_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000);
const MAX_ENTRIES = 500;

class MemoryStore implements CacheStore {
  readonly name = "memory";
  private map = new Map<string, CacheEntry>();
  async get(key: string) {
    return this.map.get(key);
  }
  async set(key: string, entry: CacheEntry) {
    if (this.map.size >= MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, entry);
  }
}

let store: CacheStore | undefined;

export function cacheStore(): CacheStore {
  // Future: if (process.env.KV_REST_API_URL) return (store ??= new KvStore(...));
  return (store ??= new MemoryStore());
}

export function cacheKey(pathname: string, params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return `${pathname}?${sorted}`;
}

export async function cacheGet(key: string, allowStale = false): Promise<unknown | undefined> {
  try {
    const entry = await cacheStore().get(key);
    if (!entry) return undefined;
    if (!allowStale && Date.now() - entry.storedAt > TTL_MS) return undefined;
    return entry.data;
  } catch {
    return undefined; // a cache failure must never break a run
  }
}

export async function cacheSet(key: string, data: unknown): Promise<void> {
  try {
    await cacheStore().set(key, { storedAt: Date.now(), data });
  } catch {
    // ignore: the cache is best-effort
  }
}
