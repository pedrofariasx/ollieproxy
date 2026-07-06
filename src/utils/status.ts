import { config } from '../config.js';

export interface ServiceStatus {
  id: string;
  name: string;
  status: 'ok' | 'down' | 'skipped' | 'error';
  latencyMs: number | null;
}

export interface ModelStatus {
  id: string;
  name: string;
  provider: string;
  status: 'ok' | 'down' | 'skipped' | 'error';
  latencyMs: number | null;
  error?: string;
}

export interface StatusResponse {
  overall: string;
  uptimeSeconds: number;
  startedAt: string;
  checkedAt: string;
  refreshSeconds: number;
  services: ServiceStatus[];
  models: ModelStatus[];
}

interface CacheEntry {
  data: StatusResponse;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

export async function fetchStatus(): Promise<StatusResponse> {
  const url = `${config.statusUrl}?fresh=1`;
  const timeout = AbortSignal.timeout(config.upstreamTimeoutMs);

  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    signal: timeout,
  });

  if (!res.ok) {
    throw new Error(`Status endpoint returned ${res.status}`);
  }

  return (await res.json()) as StatusResponse;
}

export async function getCachedStatus(): Promise<StatusResponse | null> {
  const now = Date.now();
  const ttl = config.statusCacheTtlMs;

  if (cache && now - cache.fetchedAt < ttl) {
    return cache.data;
  }

  try {
    const data = await fetchStatus();
    cache = { data, fetchedAt: now };
    return data;
  } catch {
    if (cache) {
      return cache.data;
    }
    return null;
  }
}
