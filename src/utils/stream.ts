const THINK_OPEN = /\[\[\s*think\s*\]\]/i;
const THINK_CLOSE = /\[\s*\/\s*think\s*\]\]/i;

interface ParseResult {
  content: string;
  reasoning: string;
}

/**
 * Parses all `[[think]]...[[/think]]` blocks in `s`, extracting their inner
 * text into `reasoning` and removing them from `content`. Unclosed open
 * markers funnel everything after them into `reasoning`. Multiple blocks are
 * handled in order.
 */
function parseThinking(s: string): ParseResult {
  let content = '';
  let reasoning = '';
  let i = 0;

  while (i < s.length) {
    const rest = s.slice(i);
    const openMatch = rest.match(THINK_OPEN);
    if (!openMatch || openMatch.index === undefined) {
      content += rest;
      break;
    }

    content += rest.slice(0, openMatch.index);
    const afterOpen = rest.slice(openMatch.index + openMatch[0].length);
    const closeMatch = afterOpen.match(THINK_CLOSE);

    if (!closeMatch || closeMatch.index === undefined) {
      reasoning += afterOpen;
      i = s.length;
      break;
    }

    reasoning += afterOpen.slice(0, closeMatch.index);
    i += openMatch.index + openMatch[0].length + closeMatch.index + closeMatch[0].length;
  }

  return { content, reasoning };
}

/**
 * Stateful, incremental parser for `[[think]]...[[/think]]` blocks emitted
 * inline within streamed `content`.
 *
 * Unlike a re-parse of the whole accumulated text on every chunk, this keeps a
 * small `pending` buffer of bytes not yet classifiable (because they could be
 * the start of a marker split across chunks) and only inspects newly arrived
 * data plus that buffer. This is O(n) overall and, unlike the previous
 * prefix-diff approach, never drops text when a marker completes mid-stream.
 */
export class ThinkParser {
  // 0 = Outside a think block, 1 = Inside a think block.
  private state = 0;
  private pending = '';

  reset() {
    this.state = 0;
    this.pending = '';
  }

  push(chunk: string): ParseResult {
    let buf = this.pending + chunk;
    this.pending = '';
    let content = '';
    let reasoning = '';

    while (buf.length > 0) {
      const re = this.state === 1 ? THINK_CLOSE : THINK_OPEN;
      const m = buf.match(re);

      if (m && m.index !== undefined && m.index >= 0) {
        // A full marker exists within `buf`. Everything before it is finalized
        // to the current stream; the marker itself toggles state.
        const before = buf.slice(0, m.index);
        if (this.state === 1) reasoning += before;
        else content += before;
        this.state = this.state === 1 ? 0 : 1;
        buf = buf.slice(m.index + m[0].length);
        continue;
      }

      // No full marker. Hold back a tail that could be the start of a marker
      // prefix so a split marker can complete on the next chunk. The remainder
      // is safe to flush to the current stream now.
      const held = holdMarkerPrefix(buf);
      if (held.length > 0) {
        const safe = buf.slice(0, buf.length - held.length);
        if (this.state === 1) reasoning += safe;
        else content += safe;
        this.pending = held;
      } else {
        if (this.state === 1) reasoning += buf;
        else content += buf;
      }
      break;
    }

    return { content, reasoning };
  }
}

/** Full literal marker texts, used to detect markers split across chunks. */
const MARKER_TEXTS = ['[[think]]', '[[/think]]'];

/**
 * Returns the longest suffix of `s` that is also a prefix of any think marker.
 * When a marker is split across chunks this tail is held back until it can be
 * resolved by the next chunk.
 */
function holdMarkerPrefix(s: string): string {
  let best = '';
  for (const marker of MARKER_TEXTS) {
    const maxLen = Math.min(s.length, marker.length - 1);
    for (let len = maxLen; len > best.length; len--) {
      const tail = s.slice(s.length - len);
      if (marker.startsWith(tail)) {
        if (len > best.length) best = tail;
        break;
      }
    }
  }
  return best;
}

interface UpstreamDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface UpstreamChoice {
  index?: number;
  delta?: UpstreamDelta;
  finish_reason?: string | null;
}

export interface UpstreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: UpstreamChoice[];
  usage?: Record<string, unknown> | null;
}

export class StreamTransformer {
  public thinkParser = new ThinkParser();
  private currentId = '';
  private currentModel = '';
  private currentCreated = 0;
  /** Optional PII restorer applied to `content` after think parsing. */
  private restorer: import('./redact.js').Restorer | null = null;

  /**
   * Attaches a PII restorer. When set, every `content` delta emitted by
   * `transform()` is run through `Restorer.push()` so redaction tokens are
   * swapped back for the originals. Call `flush()` at end-of-stream to release
   * any buffered tail held back for split tokens.
   */
  setRestorer(restorer: import('./redact.js').Restorer): void {
    this.restorer = restorer;
  }

  /**
   * Releases any text held back by the PII restorer's lookahead buffer. Returns
   * a partial `content` delta to emit, or `null` when there is nothing to flush.
   */
  flushRestorer(): UpstreamChunk | null {
    if (!this.restorer) return null;
    const tail = this.restorer.flush();
    if (!tail) return null;
    return {
      id: this.currentId,
      object: 'chat.completion.chunk',
      created: this.currentCreated || Math.floor(Date.now() / 1000),
      model: this.currentModel,
      choices: [{ index: 0, delta: { content: tail }, finish_reason: null }],
      usage: null,
    };
  }

  transform(chunk: UpstreamChunk): UpstreamChunk | null {
    if (!chunk || !chunk.choices || chunk.choices.length === 0) {
      return chunk ?? null;
    }

    const choice = chunk.choices[0];
    const delta = choice.delta || {};

    if (
      !delta.content &&
      !delta.tool_calls &&
      !delta.reasoning_content &&
      !delta.reasoning &&
      !delta.role
    ) {
      return chunk;
    }

    const newDelta: UpstreamDelta = {};

    if (delta.role) newDelta.role = delta.role;

    if (delta.tool_calls) {
      newDelta.tool_calls = delta.tool_calls;
    }

    if (delta.reasoning_content) {
      newDelta.reasoning_content = delta.reasoning_content;
    }
    if (delta.reasoning) {
      newDelta.reasoning_content = (newDelta.reasoning_content || '') + delta.reasoning;
    }

    if (delta.content) {
      const parsed = this.thinkParser.push(delta.content);
      if (parsed.reasoning) {
        newDelta.reasoning_content = (newDelta.reasoning_content || '') + parsed.reasoning;
      }
      if (parsed.content) {
        // Restore redacted PII tokens to their originals before emitting. The
        // restorer holds a tiny lookahead tail when a token could be split
        // across chunks; the remainder is flushed at end-of-stream.
        newDelta.content = this.restorer
          ? this.restorer.push(parsed.content)
          : parsed.content;
      }
    }

    if (Object.keys(newDelta).length === 0 && !choice.finish_reason) {
      return null;
    }

    const id = chunk.id || this.currentId;
    this.currentId = id;
    const model = chunk.model || this.currentModel;
    this.currentModel = model;
    const created = chunk.created || this.currentCreated || Math.floor(Date.now() / 1000);
    this.currentCreated = created;

    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: newDelta,
          finish_reason: choice.finish_reason || null,
        },
      ],
      usage: chunk.usage || null,
    };
  }

  reset() {
    this.thinkParser.reset();
    this.currentId = '';
    this.currentModel = '';
    this.currentCreated = 0;
    this.restorer = null;
  }
}
