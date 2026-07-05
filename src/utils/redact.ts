/**
 * Layer 1 — Reversible PII / secret redaction.
 *
 * Goal: protect personally identifiable information and credentials (emails,
 * phone numbers, CPF/CNPJ, API keys, payment cards, database URLs with
 * passwords, JWTs, private keys, AWS credentials, …) from an untrusted
 * upstream, *without* degrading the model's response. Redacted values are
 * replaced by opaque, stable tokens (`<<PII_EMAIL_1>>`, `<<PII_DBURL_1>>`, …).
 * The same value always maps to the same token within a single
 * request/response cycle, so the model can still reason about "the same email"
 * appearing twice. On the way back to the client, tokens are restored to the
 * original values.
 *
 * The mapping is held in memory only for the duration of one request and never
 * persisted or logged.
 */

/**
 * Categories of PII / secrets that can be redacted.
 *
 * - `email`, `phone`, `cpf`, `cnpj`, `apikey`, `card`: direct identifiers and
 *   long-lived credentials (in the default set).
 * - `dburl`: connection strings carrying an embedded password
 *   (`postgres://user:pass@host/db`).
 * - `jwt`: JSON Web Tokens (three base64url segments).
 * - `privatekey`: PEM blocks (`-----BEGIN … PRIVATE KEY-----`).
 * - `aws`: AWS access-key id (`AKIA…`) and secret access key (40 base64-ish).
 *
 * The categories below are *opt-in* because they carry a meaningful
 * false-positive risk on ordinary prose:
 * - `ip`: IPv4/IPv6 addresses (also matches version-like strings and hosts).
 * - `mac`: Ethernet MAC addresses (`aa:bb:cc:dd:ee:ff`).
 * - `cep`: Brazilian postal codes (`XXXXX-XXX`).
 * - `pis`: Brazilian PIS/NIT numbers (11 digits, validated).
 * - `ssn`: US Social Security Numbers (`XXX-XX-XXXX`, validated).
 * - `token`: generic `Bearer`/`token=`/`api_key=` style bearer values.
 */
export type RedactCategory =
  | 'email'
  | 'phone'
  | 'cpf'
  | 'cnpj'
  | 'apikey'
  | 'card'
  | 'dburl'
  | 'jwt'
  | 'privatekey'
  | 'aws'
  | 'ip'
  | 'mac'
  | 'cep'
  | 'pis'
  | 'ssn'
  | 'token';

/**
 * Categories enabled by default when `REDACT_PII=1` and no `REDACT_CATEGORIES`
 * is set. Chosen for high sensitivity and low false-positive rate on ordinary
 * text. Higher-FP categories (`ip`, `mac`, `cep`, `pis`, `ssn`, `token`) are
 * opt-in only.
 */
export const DEFAULT_REDACT_CATEGORIES: readonly RedactCategory[] = [
  'email',
  'phone',
  'cpf',
  'cnpj',
  'apikey',
  'card',
  'dburl',
  'jwt',
  'privatekey',
  'aws',
];

/**
 * Every category the redactor knows about. `REDACT_CATEGORIES=all` expands to
 * this list. Kept in detection order (most specific / longest first) so the
 * non-overlap pass prefers the canonical span.
 */
export const ALL_REDACT_CATEGORIES: readonly RedactCategory[] = [
  'email',
  'phone',
  'cpf',
  'cnpj',
  'apikey',
  'card',
  'dburl',
  'jwt',
  'privatekey',
  'aws',
  'ip',
  'mac',
  'cep',
  'pis',
  'ssn',
  'token',
];

/** Human-readable labels used inside the opaque tokens. */
const CATEGORY_LABEL: Record<RedactCategory, string> = {
  email: 'EMAIL',
  phone: 'PHONE',
  cpf: 'CPF',
  cnpj: 'CNPJ',
  apikey: 'APIKEY',
  card: 'CARD',
  dburl: 'DBURL',
  jwt: 'JWT',
  privatekey: 'KEY',
  aws: 'AWS',
  ip: 'IP',
  mac: 'MAC',
  cep: 'CEP',
  pis: 'PIS',
  ssn: 'SSN',
  token: 'TOKEN',
};

/**
 * A single detected span of PII within some text: the matched substring, the
 * category, and the start/end offsets in the original text.
 */
interface Detection {
  category: RedactCategory;
  match: string;
  start: number;
  end: number;
}

/* -------------------------------------------------------------------------- */
/* Patterns                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Email address. Delimited by word boundaries on both sides; deliberately
 * conservative (no stray punctuation) to avoid swallowing surrounding prose.
 */
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * International / Brazilian phone numbers. Accepts an optional country code
 * (`+55`), grouped digits, and the common separators `-`, space, and `.`
 * followed by an optional `#` extension. We require at least 8 digits after
 * any non-DDD prefix so short numeric fragments don't trigger a match.
 */
const PHONE_RE =
  /(?<![\w])(?:\+\d{1,3}\s?)?(?:\(\d{1,4}\)\s?)?\d[\d\s.-]{6,}\d(?::?\s?#\d{1,6})?(?![\w])/g;

/**
 * CPF: 11 digits, optionally formatted as `XXX.XXX.XXX-XX`. Validated via the
 * standard CPF check-digit algorithm.
 */
const CPF_RE = /\b(?:\d{3}\.?\d{3}\.?\d{3}-?)?(\d{2})\b/g;

/**
 * CNPJ: 14 digits, optionally formatted as `XX.XXX.XXX/XXXX-XX`. Validated via
 * the standard CNPJ check-digit algorithm.
 */
const CNPJ_RE = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;

/**
 * Common long-lived API key formats (OpenAI `sk-...`, Anthropic `sk-ant-...`,
 * generic 32+ hex/alnum secrets). Kept broad on purpose: false positives here
 * only matter inside the proxy mapping, and the restoration step makes them
 * invisible to the client.
 */
const APIKEY_RE =
  /\b(?:sk-ant-[A-Za-z0-9_\-]{20,}|sk-[A-Za-z0-9_\-]{20,}|(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|AIza[0-9A-Za-z_\-]{30,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9]{40,})\b/g;

/**
 * Payment card number: 13–19 digits, optionally grouped in 4s separated by
 * spaces or dashes. Validated with the Luhn checksum so 16-digit sequences
 * that aren't cards (e.g. order numbers) are left alone.
 */
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

/**
 * Database / service connection string carrying an embedded password. Matches
 * schemes commonly pasted into chat: `postgres(ql)://`, `mysql://`, `mongodb(+srv)://`,
 * `redis://`, `amqp://`, `mssql://`, plus the generic `user:pass@host` form.
 * Requires a non-empty password so bare `host:port` references are not touched.
 */
const DBURL_RE =
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+(?:\/[^\s]*)?/gi;

/**
 * JSON Web Token: three base64url segments joined by dots, header at least 10
 * chars. The leading `ey` covers the typical `{"alg":…}` header so we don't
 * match arbitrary `a.b.c` prose. Uses the `d` flag so capture/submatch indices
 * are available without recomputation.
 */
const JWT_RE = /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/gd;

/**
 * PEM private key block, from `-----BEGIN … PRIVATE KEY-----` through the
 * matching `-----END … PRIVATE KEY-----`. Covers RSA, EC, OPENSSH, PKCS8,
 * PGP, etc. Multi-line via the `s` (dotall) flag.
 */
const PRIVATEKEY_RE =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gd;

/**
 * AWS credentials: 20-char access key id starting with `AKIA`/`ASIA`/`AGPA`/
 * `AIDA`/`AROA`/`AIPA`/`ANPA`/`ANVA`/`APKA`, and the 40-char secret access key
 * (base64-ish). Both forms are emitted under the `aws` category.
 */
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|APKA)[A-Z0-9]{16}\b/g;
const AWS_SECRET_RE = /\b[A-Za-z0-9/+=]{40}\b/g;

/**
 * IPv4 address. Opt-in: also matches dotted version strings and quad host
 * names, hence not in the default set.
 */
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/**
 * IPv6 address (common forms, including the `::` zero-compression shorthand).
 * Opt-in for the same reason as IPv4. Covers full, compressed (`::`), and
 * leading/trailing empty forms (e.g. `::1`, `fe80::1`).
 */
const IPV6_RE =
  /(?<![\w.:])(?:[A-Fa-f0-9]{1,4}(?::[A-Fa-f0-9]{1,4}){7}|(?:[A-Fa-f0-9]{1,4}:){1,7}:|:(?::[A-Fa-f0-9]{1,4}){1,7}|[A-Fa-f0-9]{1,4}(?::[A-Fa-f0-9]{0,4}){1,6}(?::[A-Fa-f0-9]{1,4})?)(?![\w.:])/g;

/**
 * Ethernet MAC address: six hex octets separated by `:` or `-`.
 */
const MAC_RE = /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g;

/**
 * Brazilian postal code (CEP): `XXXXX-XXX` or 8 bare digits. Validated by the
 * IBGE range 00000000–99999999 with the conventional 8-digit length.
 */
const CEP_RE = /\b\d{5}-?\d{3}\b/g;

/**
 * Brazilian PIS/NIT number: 11 digits, optionally formatted as
 * `XXX.XXXXX.XX-X`. Validated via its check-digit algorithm.
 */
const PIS_RE = /\b\d{3}\.?\d{5}\.?\d{2}-?\d\b/g;

/**
 * US Social Security Number: `XXX-XX-XXXX` or 9 bare digits. Validated against
 * the SSA rules (no field all-zero, area not 666/900–999, group != 0).
 */
const SSN_RE = /\b\d{3}-?\d{2}-?\d{4}\b/g;

/**
 * Generic bearer token occurrences: `Bearer <value>`, `token=<value>`,
 * `api_key=<value>`, `access_token=<value>`, `Authorization: <value>`. Captures
 * the value after the keyword. Opt-in because the boundary is fuzzy. Uses the
 * `d` flag so the captured value's offsets are available.
 */
const BEARER_RE =
  /(?:\bBearer\s+|\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd)\s*[=:]\s*)([^\s"',;}\]]+)/gid;

/* -------------------------------------------------------------------------- */
/* Validators                                                                 */
/* -------------------------------------------------------------------------- */

/** Strip non-digit characters. */
function digitsOnly(s: string): string {
  return s.replace(/\D+/g, '');
}

/**
 * Computes the two CPF verification digits and compares them against the last
 * two digits of `raw` (which may be formatted). Returns true for a valid CPF.
 */
export function isValidCpf(raw: string): boolean {
  const cpf = digitsOnly(raw);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false; // all equal digits are invalid

  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (cpf.charCodeAt(i) - 48) * (10 - i);
  let d1 = 11 - (sum % 11);
  if (d1 >= 10) d1 = 0;
  if (d1 !== cpf.charCodeAt(9) - 48) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) sum += (cpf.charCodeAt(i) - 48) * (11 - i);
  let d2 = 11 - (sum % 11);
  if (d2 >= 10) d2 = 0;
  return d2 === cpf.charCodeAt(10) - 48;
}

/**
 * Computes the two CNPJ verification digits and compares them against the last
 * two digits of `raw`. Returns true for a valid CNPJ.
 */
export function isValidCnpj(raw: string): boolean {
  const cnpj = digitsOnly(raw);
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const weights1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (cnpj.charCodeAt(i) - 48) * weights1[i];
  let d1 = sum % 11;
  d1 = d1 < 2 ? 0 : 11 - d1;
  if (d1 !== cnpj.charCodeAt(12) - 48) return false;

  const weights2 = [6, ...weights1];
  sum = 0;
  for (let i = 0; i < 13; i++) sum += (cnpj.charCodeAt(i) - 48) * weights2[i];
  let d2 = sum % 11;
  d2 = d2 < 2 ? 0 : 11 - d2;
  return d2 === cnpj.charCodeAt(13) - 48;
}

/** Luhn checksum, used for payment card numbers. */
export function luhnValid(raw: string): boolean {
  const s = digitsOnly(raw);
  if (s.length < 13 || s.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Returns true when `s` contains at least `min` digits. */
function hasMinDigits(s: string, min: number): boolean {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) {
      n++;
      if (n >= min) return true;
    }
  }
  return false;
}

/**
 * PIS/NIT check-digit validation. The 11-digit number uses a weight sequence
 * 3,2,9,8,7,6,5,4,3,2 over the first 10 digits; the remainder must match the
 * 11th.
 */
export function isValidPis(raw: string): boolean {
  const pis = digitsOnly(raw);
  if (pis.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(pis)) return false;
  const weights = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (pis.charCodeAt(i) - 48) * weights[i];
  const d = 11 - (sum % 11);
  const expected = d >= 10 ? 0 : d;
  return expected === pis.charCodeAt(10) - 48;
}

/**
 * US Social Security Number validation following the public SSA rules:
 * - Area (first 3) cannot be 000, 666, or 900–999.
 * - Group (middle 2) cannot be 00.
 * - Serial (last 4) cannot be 0000.
 */
export function isValidSsn(raw: string): boolean {
  const s = digitsOnly(raw);
  if (s.length !== 9) return false;
  const area = +s.slice(0, 3);
  const group = +s.slice(3, 5);
  const serial = +s.slice(5, 9);
  if (area === 0 || area === 666 || area >= 900) return false;
  if (group === 0) return false;
  if (serial === 0) return false;
  return true;
}

/** True when `raw` is a valid IPv4 address (each octet 0–255). */
export function isValidIpv4(raw: string): boolean {
  const parts = raw.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = +p;
    if (n > 255) return false;
    if (p.length > 1 && p[0] === '0') return false; // no leading zeros
  }
  return true;
}

/** CEP is valid as long as it's exactly 8 digits (00000-000 … 99999-999). */
export function isValidCep(raw: string): boolean {
  return digitsOnly(raw).length === 8;
}

/** AWS secret access key heuristic: 40 chars of base64 alphabet, not all same. */
function looksLikeAwsSecret(raw: string): boolean {
  if (raw.length !== 40) return false;
  if (!/^[A-Za-z0-9/+=]+$/.test(raw)) return false;
  return !/^(\W)\1{39}$/.test(raw);
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

interface PatternSpec {
  category: RedactCategory;
  /**
   * Pattern to run. When `captureGroup` is set, the value to redact is taken
   * from that regex group instead of the whole match (used by `token`, which
   * redacts only the secret after the `Bearer`/`token=` keyword). Patterns
   * with a captureGroup must carry the `d` flag so `m.indices` is populated.
   */
  re: RegExp;
  validate?: (s: string) => boolean;
  captureGroup?: number;
}

/**
 * Detection order matters: the most specific / longest patterns run first so
 * the non-overlap pass keeps the canonical span (e.g. a 40-char AWS secret is
 * tried before the generic 40-char `apikey` alnum pattern).
 */
const ALL_PATTERNS: PatternSpec[] = [
  // Long, unambiguous secrets first.
  { category: 'privatekey', re: PRIVATEKEY_RE },
  { category: 'dburl', re: DBURL_RE },
  { category: 'jwt', re: JWT_RE },
  { category: 'aws', re: AWS_ACCESS_KEY_RE },
  { category: 'aws', re: AWS_SECRET_RE, validate: looksLikeAwsSecret },
  { category: 'apikey', re: APIKEY_RE },
  { category: 'email', re: EMAIL_RE },
  { category: 'cnpj', re: CNPJ_RE, validate: isValidCnpj },
  { category: 'cpf', re: CPF_RE, validate: isValidCpf },
  { category: 'card', re: CARD_RE, validate: luhnValid },
  { category: 'phone', re: PHONE_RE, validate: (s) => hasMinDigits(s, 8) },
  // Opt-in, higher false-positive risk.
  { category: 'ssn', re: SSN_RE, validate: isValidSsn },
  { category: 'pis', re: PIS_RE, validate: isValidPis },
  { category: 'cep', re: CEP_RE, validate: isValidCep },
  { category: 'mac', re: MAC_RE },
  { category: 'ip', re: IPV4_RE, validate: isValidIpv4 },
  { category: 'ip', re: IPV6_RE },
  { category: 'token', re: BEARER_RE, captureGroup: 1 },
];

/**
 * Scans `text` for enabled PII categories and returns non-overlapping
 * detections, sorted by start offset. Longest/earliest wins on conflict.
 *
 * Detection order is set by `ALL_PATTERNS` so a 14-digit CNPJ isn't misread as
 * an 11-digit CPF and a 40-char AWS secret beats the generic `apikey` form;
 * the non-overlap pass below then keeps the canonical span.
 */
function detect(text: string, enabled: ReadonlySet<RedactCategory>): Detection[] {
  const found: Detection[] = [];

  for (const spec of ALL_PATTERNS) {
    if (!enabled.has(spec.category)) continue;
    spec.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = spec.re.exec(text)) !== null) {
      let value = m[0];
      let start = m.index;
      let end = m.index + m[0].length;

      // For capture-group patterns (e.g. `token`), redact only the captured
      // secret, not the leading `Bearer ` / `token=` keyword. The regex must
      // carry the `d` flag so `m.indices` exposes the group offsets.
      if (spec.captureGroup !== undefined) {
        const indices = (m as RegExpExecArray & { indices?: RegExpIndicesArray }).indices;
        const grp = indices?.[spec.captureGroup];
        if (!grp) continue; // capture unavailable; skip this match
        start = grp[0];
        end = grp[1];
        value = text.slice(start, end);
        if (!value) continue;
      }

      if (spec.validate && !spec.validate(value)) continue;
      found.push({ category: spec.category, match: value, start, end });
      if (m[0].length === 0) spec.re.lastIndex++; // guard against zero-width
    }
  }

  // Resolve overlaps: keep earliest, then longest. This naturally prefers CNPJ
  // (14 digits, found at the same start) over CPF (11 digits) and card over
  // loose phone matches.
  found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out: Detection[] = [];
  let lastEnd = -1;
  for (const d of found) {
    if (d.start < lastEnd) continue; // overlaps a kept detection
    out.push(d);
    lastEnd = d.end;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Redactor                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Owns the token <-> original mapping for one request. `redact()` rewrites
 * plaintext by replacing PII spans with opaque tokens; the same original value
 * always yields the same token, so the model can still reference "the same
 * email" across messages.
 */
export class Redactor {
  private readonly enabled: ReadonlySet<RedactCategory>;
  private readonly originalToToken = new Map<string, string>();
  private readonly counters = new Map<RedactCategory, number>();

  constructor(enabled: Iterable<RedactCategory> = DEFAULT_REDACT_CATEGORIES) {
    this.enabled = new Set(enabled);
  }

  get isEnabled(): boolean {
    return this.enabled.size > 0;
  }

  /** Categories currently active. */
  activeCategories(): RedactCategory[] {
    return [...this.enabled];
  }

  /**
   * Returns the redacted form of `text`. When nothing matches, returns the
   * input unchanged. The token mapping is recorded for later restoration.
   */
  redact(text: string): string {
    if (!this.isEnabled || !text) return text;
    const detections = detect(text, this.enabled);
    if (detections.length === 0) return text;

    let out = '';
    let cursor = 0;
    for (const d of detections) {
      out += text.slice(cursor, d.start);
      out += this.tokenFor(d.category, d.match);
      cursor = d.end;
    }
    out += text.slice(cursor);
    return out;
  }

  /** Lookup or mint a token for a given original value. */
  private tokenFor(category: RedactCategory, original: string): string {
    const key = `${category}::${original}`;
    const existing = this.originalToToken.get(key);
    if (existing) return existing;

    const n = (this.counters.get(category) ?? 0) + 1;
    this.counters.set(category, n);
    const token = `<<PII_${CATEGORY_LABEL[category]}_${n}>>`;
    this.originalToToken.set(key, token);
    return token;
  }

  /**
   * Returns the reverse mapping (token -> original) needed by the Restorer.
   * Exposed so the route layer can hand it to the streaming/non-streaming
   * restorers without leaking the originals anywhere else.
   */
  buildRestorer(): Restorer {
    const tokenToOriginal = new Map<string, string>();
    for (const [key, token] of this.originalToToken) {
      const sep = key.indexOf('::');
      const original = sep >= 0 ? key.slice(sep + 2) : key;
      tokenToOriginal.set(token, original);
    }
    return new Restorer(tokenToOriginal);
  }
}

/* -------------------------------------------------------------------------- */
/* Restorer (streaming-safe with lookahead)                                   */
/* -------------------------------------------------------------------------- */

/** Matches any token we emit: `<<PII_<LABEL>_<N>>>`. */
const TOKEN_RE = /<<PII_[A-Z]+_\d+>>/g;

/**
 * Replaces redaction tokens with their original values.
 *
 * In a streamed response a token can be split across chunks (e.g. `<<PII_EMA`
 * then `IL_1>>`). `push()` therefore retains a small tail buffer when the input
 * ends with what *might* be the start of a token, and only flushes text once it
 * is certain no token can begin at the held position. `flush()` must be called
 * at end-of-stream to release any remaining buffered text.
 */
export class Restorer {
  private readonly tokenToOriginal: Map<string, string>;
  private pending = '';

  constructor(tokenToOriginal: Map<string, string>) {
    this.tokenToOriginal = tokenToOriginal;
  }

  /** True when there are no tokens to restore — lets callers skip buffering. */
  get isEmpty(): boolean {
    return this.tokenToOriginal.size === 0;
  }

  /**
   * Consumes `chunk` and returns whatever can be safely emitted to the client.
   * A tail that could be the prefix of a token is retained until the next call
   * (or `flush()`).
   */
  push(chunk: string): string {
    if (this.tokenToOriginal.size === 0) return chunk;
    let buf = this.pending + chunk;
    this.pending = '';
    let out = '';

    while (buf.length > 0) {
      TOKEN_RE.lastIndex = 0;
      const m = TOKEN_RE.exec(buf);
      if (m && m.index >= 0) {
        // Emit any text before the token, then the restored value.
        out += buf.slice(0, m.index);
        const token = m[0];
        out += this.tokenToOriginal.get(token) ?? token;
        buf = buf.slice(m.index + token.length);
        continue;
      }

      // No full token in `buf`. Hold back a tail that could begin a token so a
      // split token can complete on the next chunk; emit the safe prefix.
      const held = holdTokenPrefix(buf);
      if (held.length > 0) {
        out += buf.slice(0, buf.length - held.length);
        this.pending = held;
      } else {
        out += buf;
      }
      break;
    }

    return out;
  }

  /** Releases any buffered tail at end-of-stream. */
  flush(): string {
    const out = this.pending;
    this.pending = '';
    return out;
  }

  /**
   * Restores a complete, non-streamed string in one shot. Equivalent to
   * `push(s) + flush()` but slightly cheaper when there is no chunking.
   */
  restoreAll(s: string): string {
    if (this.tokenToOriginal.size === 0) return s;
    return this.push(s) + this.flush();
  }
}

/**
 * Returns the longest suffix of `s` that is also a prefix of some token, so a
 * token split across chunks isn't emitted as partial text. We look for the
 * shared opening `<<PII_` plus any continuation that matches a known token
 * prefix; this keeps the held buffer at most a few bytes.
 */
function holdTokenPrefix(s: string): string {
  // The literal start every token shares.
  const opener = '<<PII_';
  // Consider only the tail that could overlap the opener or beyond.
  const maxLook = Math.min(s.length, 64); // tokens are short; cap the work
  const tail = s.slice(s.length - maxLook);

  // We want the LONGEST suffix of `s` that is also a prefix of some token.
  // Suffixes from longest to shortest are tail.slice(k) for k = 0..len-1, so
  // iterate k ascending and return the first (longest) match.
  for (let k = 0; k < tail.length; k++) {
    const candidate = tail.slice(k);
    if (opener.startsWith(candidate) || candidate.startsWith(opener)) {
      if (isTokenPrefix(candidate)) {
        return candidate;
      }
    }
  }
  return '';
}

/**
 * True when `s` could be a prefix of a token `<<PII_<LABEL>_<N>>>`. We accept
 * any string that begins (or could begin) with `<<` and contains only the
 * characters that may appear in a token: `<`, `>`, uppercase letters, digits,
 * and `_`. Being loose here is safe: a non-token held back is simply emitted
 * as literal text once it can no longer match `TOKEN_RE`. Being strict, on the
 * other hand, would drop text and corrupt the stream, so we err toward holding.
 */
function isTokenPrefix(s: string): boolean {
  if (s.length === 0) return false;
  // Must start with `<<` (or be a prefix of `<<`).
  if (s.length === 1) return s === '<';
  if (!s.startsWith('<<')) return false;
  // Remainder must be only token characters.
  return /^[A-Z0-9_<>]*$/.test(s.slice(2));
}
