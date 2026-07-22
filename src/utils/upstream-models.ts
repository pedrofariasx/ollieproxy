import { config } from '../config.js';

const SUFFIX_LEVELS = ['low', 'medium', 'high', 'max'] as const;

interface UpstreamModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
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

  const json = (await res.json()) as { data: UpstreamModel[] };
  return json.data ?? [];
}

function expandWithVariants(baseModels: UpstreamModel[]): UpstreamModel[] {
  const out: UpstreamModel[] = [];

  for (const m of baseModels) {
    out.push({ ...m });

    for (const lvl of SUFFIX_LEVELS) {
      out.push({
        id: `${m.id}-${lvl}`,
        object: 'model',
        created: m.created,
        owned_by: m.owned_by,
      });
    }
  }

  return out;
}

export async function getModels(): Promise<UpstreamModel[]> {
  const now = Date.now();
  const ttl = config.modelsCacheTtlMs;

  if (cache && now - cache.fetchedAt < ttl) {
    return cache.models;
  }

  try {
    const baseModels = await fetchFromUpstream();
    const models = expandWithVariants(baseModels);
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
