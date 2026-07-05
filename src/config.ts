function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * Parses a comma-separated env var into a trimmed, de-duplicated, lowercased
 * list. Empty entries are dropped. Returns `[]` when the variable is unset or
 * blank so callers can fall back to a default.
 */
function listEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const v = part.trim().toLowerCase();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

import { DEFAULT_REDACT_CATEGORIES, ALL_REDACT_CATEGORIES, RedactCategory } from './utils/redact.js';

/**
 * Resolves the redaction category list from env. Accepts `REDACT_CATEGORIES`
 * as a comma-separated list (e.g. `email,phone,cpf`) or the literal `all` to
 * enable every category including the higher-false-positive opt-in ones
 * (`ip`, `mac`, `cep`, `pis`, `ssn`, `token`). When redaction is enabled but
 * the list is empty, the default set is used. Unknown tokens are dropped with
 * a warning logged by the caller.
 */
function resolveRedactCategories(enabled: boolean): RedactCategory[] {
  if (!enabled) return [];
  const raw = listEnv('REDACT_CATEGORIES');
  if (raw.length === 0) return [...DEFAULT_REDACT_CATEGORIES];
  if (raw.length === 1 && raw[0] === 'all') return [...ALL_REDACT_CATEGORIES];
  const known = new Set<string>(ALL_REDACT_CATEGORIES as readonly string[]);
  return raw.filter((c): c is RedactCategory => known.has(c));
}

/**
 * Layer 1 — reversible PII redaction. ON by default; set `REDACT_PII=0` to
 * disable. When on, request messages are scanned for the enabled categories
 * and matches are replaced with opaque tokens before reaching the upstream;
 * tokens are restored to the originals on the response back to the client.
 */
const redactEnabled = boolEnv('REDACT_PII', true);
const redactCategories = resolveRedactCategories(redactEnabled);
if (redactEnabled && redactCategories.length === 0) {
  // Enabled but every token was unknown — log loudly at startup instead of
  // silently disabling.
  console.warn(
    `[ollieproxy] REDACT_PII=1 but REDACT_CATEGORIES matched no known category; ` +
      `redaction will be inactive. Known: ${DEFAULT_REDACT_CATEGORIES.join(', ')}`,
  );
}

export const config = {
  port: intEnv('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  upstreamUrl: process.env.UPSTREAM_URL || 'https://olliechat-lac.vercel.app/',
  /** Upstream request timeout in milliseconds. */
  upstreamTimeoutMs: intEnv('UPSTREAM_TIMEOUT_MS', 120_000),
  /** Maximum request body size in bytes (Fastify `bodyLimit`). */
  bodyLimitBytes: intEnv('BODY_LIMIT_BYTES', 4 * 1024 * 1024),
  /**
   * Layer 1 — reversible PII redaction. ON by default; set `REDACT_PII=0` to
   * disable. When on, request messages are scanned for the enabled categories
   * and matches are replaced with opaque tokens before reaching the upstream;
   * tokens are restored to the originals on the response back to the client.
   */
  redact: {
    enabled: redactEnabled && redactCategories.length > 0,
    categories: redactCategories,
  },
  /**
   * API-key authentication + per-key rate limiting.
   *
   * `AUTH_ENABLED` is OFF by default so the proxy stays open until the operator
   * creates keys via the CLI and flips it on. Keys are stored hashed in
   * `KEYS_FILE` (default `./data/keys.json`). `DEFAULT_RPM` is the per-minute
   * request cap applied to any key that doesn't override it.
   */
  auth: {
    enabled: boolEnv('AUTH_ENABLED', false),
    keysFile: process.env.KEYS_FILE || './data/keys.json',
    defaultRpm: intEnv('DEFAULT_RPM', 60),
  },
  /** Cache TTL for upstream models (ms). */
  modelsCacheTtlMs: intEnv('MODELS_CACHE_TTL_MS', 300_000),
} as const;
