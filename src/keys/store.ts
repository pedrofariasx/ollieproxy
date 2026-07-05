import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';

/**
 * JSON-file backing store for API keys.
 *
 * Keys are stored only as their SHA-256 hash, never in cleartext, so a leaked
 * `keys.json` does not reveal usable credentials. The full plaintext key is
 * returned to the operator exactly once, at creation time, via the CLI.
 *
 * The file is written atomically (temp file + rename) so a crash mid-write
 * cannot corrupt the store. Format version is pinned so future migrations can
 * be detected.
 */

const STORE_VERSION = 1;

/** Prefix that marks a key as belonging to this proxy. Aids visual recognition. */
export const KEY_PREFIX = 'op_';

export interface KeyRecord {
  /** Stable identifier (short, random), used in CLI output and the admin API. */
  id: string;
  /** SHA-256 hex of the full plaintext key. Lookup key for verification. */
  hash: string;
  /** Human label for the operator, e.g. "ci-pipeline" or "acme-client". */
  label: string;
  /** Unix epoch milliseconds when the key was created. */
  createdAt: number;
  /** Per-key rate limit: max requests per minute. `null` = use global default. */
  rpm: number | null;
  /** Soft-removed: verification fails for revoked keys even if the hash matches. */
  revoked: boolean;
  /** Optional expiry (epoch ms). Verification fails after this. */
  expiresAt: number | null;
}

interface StoreFile {
  version: number;
  keys: KeyRecord[];
}

/** Empty store skeleton. */
function emptyStore(): StoreFile {
  return { version: STORE_VERSION, keys: [] };
}

/**
 * Owns reads/writes to `keys.json`. A single instance is shared by the server
 * process; the CLI uses `load()`/`save()` directly for one-shot operations.
 */
export class KeyStore {
  constructor(private readonly file: string) {}

  /** Path to the backing file, exposed for mtime-based reloads. */
  get filePath(): string {
    return this.file;
  }

  /** True when the store file exists on disk. */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.file);
      return true;
    } catch {
      return false;
    }
  }

  /** Loads and validates the store, returning an empty store if absent. */
  async load(): Promise<StoreFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch {
      return emptyStore();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`keys file ${this.file} is not valid JSON`);
    }
    return normalize(parsed);
  }

  /**
   * Persists the store atomically. Creates the parent directory if needed.
   */
  async save(store: StoreFile): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    const data = JSON.stringify(store, null, 2) + '\n';
    await fs.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  /** Returns the record whose hash matches, or `null`. */
  async findByHash(hash: string): Promise<KeyRecord | null> {
    const store = await this.load();
    return store.keys.find((k) => k.hash === hash && !k.revoked) ?? null;
  }

  /** All records, including revoked ones, in creation order. */
  async list(): Promise<KeyRecord[]> {
    const store = await this.load();
    return store.keys;
  }

  /** Creates a new key, persists it, and returns the record + plaintext. */
  async create(opts: {
    label: string;
    rpm?: number | null;
    expiresAt?: number | null;
  }): Promise<{ record: KeyRecord; plaintext: string }> {
    const store = await this.load();
    const id = randomId(8);
    const plaintext = newPlaintextKey();
    const hash = sha256hex(plaintext);
    const record: KeyRecord = {
      id,
      hash,
      label: opts.label,
      createdAt: Date.now(),
      rpm: opts.rpm ?? null,
      revoked: false,
      expiresAt: opts.expiresAt ?? null,
    };
    store.keys.push(record);
    await this.save(store);
    return { record, plaintext };
  }

  /** Marks a key revoked by id. Returns the revoked record or `null`. */
  async revoke(id: string): Promise<KeyRecord | null> {
    const store = await this.load();
    const rec = store.keys.find((k) => k.id === id);
    if (!rec) return null;
    rec.revoked = true;
    await this.save(store);
    return rec;
  }

  /**
   * Hard-deletes a key record by id (irreversible). Unlike `revoke`, the row is
   * removed from `keys.json` and disappears from `list`. Returns the removed
   * record, or `null` if no key has that id.
   */
  async remove(id: string): Promise<KeyRecord | null> {
    const store = await this.load();
    const idx = store.keys.findIndex((k) => k.id === id);
    if (idx === -1) return null;
    const [removed] = store.keys.splice(idx, 1);
    await this.save(store);
    return removed;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** SHA-256 of a string, returned as lowercase hex. */
export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Generates a fresh plaintext key: `op_` + 32 base62 chars. */
function newPlaintextKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(32);
  let out = KEY_PREFIX;
  for (let i = 0; i < 32; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/** Short random id for the `id` field. */
function randomId(len: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Coerces an untrusted parsed value into a valid StoreFile, or throws. */
function normalize(parsed: unknown): StoreFile {
  if (!parsed || typeof parsed !== 'object') return emptyStore();
  const obj = parsed as Record<string, unknown>;
  const version = typeof obj.version === 'number' ? obj.version : STORE_VERSION;
  if (version > STORE_VERSION) {
    throw new Error(
      `keys file version ${version} is newer than supported ${STORE_VERSION}; upgrade the proxy.`,
    );
  }
  const arr = Array.isArray(obj.keys) ? obj.keys : [];
  const keys: KeyRecord[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.hash !== 'string' || typeof r.label !== 'string') {
      continue;
    }
    keys.push({
      id: r.id,
      hash: r.hash,
      label: r.label,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
      rpm: typeof r.rpm === 'number' ? r.rpm : null,
      revoked: r.revoked === true,
      expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : null,
    });
  }
  return { version: STORE_VERSION, keys };
}
