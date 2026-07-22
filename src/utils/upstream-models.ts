import { config } from '../config.js';

interface UpstreamModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface RawUpstreamModel {
  id: string;
  name: string;
  brand: string;
  vision: boolean;
  disabled: boolean;
  provider: string;
}

interface RawModelsResponse {
  models: RawUpstreamModel[];
}

interface CacheEntry {
  models: UpstreamModel[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

async function fetchFromUpstream(): Promise<UpstreamModel[]> {
  const url = `${config.upstreamUrl}/api/models`;
  const timeout = AbortSignal.timeout(config.upstreamTimeoutMs);

  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    signal: timeout,
  });

  if (!res.ok) {
    throw new Error(`Upstream models endpoint returned ${res.status}`);
  }

  const json = (await res.json()) as RawModelsResponse;
  const nowUnix = Math.floor(Date.now() / 1000);
  return (json.models ?? []).map((m) => ({
    id: m.id,
    object: 'model',
    created: nowUnix,
    owned_by: m.brand,
  }));
}

export async function getModels(): Promise<UpstreamModel[]> {
  const now = Date.now();
  const ttl = config.modelsCacheTtlMs;

  if (cache && now - cache.fetchedAt < ttl) {
    return cache.models;
  }

  try {
    const models = await fetchFromUpstream();
    cache = { models, fetchedAt: now };
    return models;
  } catch (err) {
    if (cache) {
      console.warn(`[ollieproxy] Failed to refresh models from upstream, serving stale cache: ${err instanceof Error ? err.message : String(err)}`);
      return cache.models;
    }
    console.warn(`[ollieproxy] Failed to fetch models from upstream, returning empty list: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
