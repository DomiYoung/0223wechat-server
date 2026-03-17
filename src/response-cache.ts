type CacheEntry<T> = {
  value?: T;
  expiresAt: number;
  inflight?: Promise<T>;
  touchedAt: number;
};

const responseCache = new Map<string, CacheEntry<unknown>>();
const MAX_CACHE_SIZE = Number.parseInt(process.env.RESPONSE_CACHE_MAX_SIZE || '', 10) || 500;
const CLEANUP_INTERVAL_MS = Number.parseInt(process.env.RESPONSE_CACHE_CLEANUP_MS || '', 10) || 60_000;

function deleteExpiredEntries(now = Date.now()) {
  for (const [key, entry] of responseCache.entries()) {
    if (entry.expiresAt <= now && !entry.inflight) {
      responseCache.delete(key);
    }
  }
}

function enforceCacheSizeLimit() {
  if (responseCache.size <= MAX_CACHE_SIZE) return;

  deleteExpiredEntries();
  if (responseCache.size <= MAX_CACHE_SIZE) return;

  const evictable = Array.from(responseCache.entries())
    .filter(([, entry]) => !entry.inflight)
    .sort((a, b) => a[1].touchedAt - b[1].touchedAt);

  while (responseCache.size > MAX_CACHE_SIZE && evictable.length > 0) {
    const [key] = evictable.shift()!;
    responseCache.delete(key);
  }
}

const cleanupTimer = setInterval(() => {
  deleteExpiredEntries();
  enforceCacheSizeLimit();
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

export async function remember<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const entry = responseCache.get(key) as CacheEntry<T> | undefined;
  if (entry?.value !== undefined && entry.expiresAt > now) {
    entry.touchedAt = now;
    return entry.value;
  }
  if (entry?.inflight) {
    entry.touchedAt = now;
    return entry.inflight;
  }

  const inflight = fn()
    .then((value) => {
      responseCache.set(key, { value, expiresAt: Date.now() + ttlMs, touchedAt: Date.now() });
      enforceCacheSizeLimit();
      return value;
    })
    .finally(() => {
      const current = responseCache.get(key) as CacheEntry<T> | undefined;
      if (current?.inflight === inflight) delete current.inflight;
    });

  responseCache.set(key, { expiresAt: now + ttlMs, inflight, touchedAt: now });
  enforceCacheSizeLimit();
  return inflight;
}

export function forget(key: string) {
  responseCache.delete(key);
}

export function forgetByPrefix(prefix: string) {
  for (const key of responseCache.keys()) {
    if (key.startsWith(prefix)) responseCache.delete(key);
  }
}
