import { FastifyInstance, FastifyReply } from 'fastify';
import { ChatCompletionRequest, ChatCompletionRequestType, ChatMessageType } from '../schemas.js';
import { config } from '../config.js';
import { StreamTransformer, UpstreamChunk } from '../utils/stream.js';
import { parseModel, thinkingToUpstream, ThinkingLevel } from '../utils/model.js';
import { Redactor } from '../utils/redact.js';

const CHAT_URL = `${config.upstreamUrl}/api/chat`;

const RESPONSE_SUFFIX =
  process.env.RESPONSE_SUFFIX ?? 'Made by Reid | https://discord.gg/4HtF9BQsG';

class SuffixStripper {
  private buffer = '';

  push(chunk: string): string {
    this.buffer += chunk;
    if (this.buffer.length <= RESPONSE_SUFFIX.length) return '';
    const safeLen = this.buffer.length - RESPONSE_SUFFIX.length;
    const safe = this.buffer.slice(0, safeLen);
    this.buffer = this.buffer.slice(safeLen);
    return safe;
  }

  flush(): string {
    const result = this.buffer.endsWith(RESPONSE_SUFFIX)
      ? this.buffer.slice(0, -RESPONSE_SUFFIX.length)
      : this.buffer;
    this.buffer = '';
    return result;
  }
}

function stripTextSuffix(text: string): string {
  return text.endsWith(RESPONSE_SUFFIX)
    ? text.slice(0, -RESPONSE_SUFFIX.length)
    : text;
}

interface ToolCallAccumulator {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export async function chatRoutes(app: FastifyInstance) {
  app.post('/v1/chat/completions', async (request, reply) => {
    const parseResult = ChatCompletionRequest.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          message: parseResult.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
          type: 'invalid_request_error',
          code: 400,
        },
      });
    }

    const body = parseResult.data;
    const isStream = body.stream;

    if (body.n !== undefined && body.n > 1) {
      return reply.status(400).send({
        error: {
          message: 'n > 1 is not supported by this proxy',
          type: 'invalid_request_error',
          code: 400,
        },
      });
    }

    // Thinking level: explicit `reasoning_effort` in the body wins; otherwise it
    // is derived from the model-name suffix (e.g. `claude-fable-5-max` -> max).
    const { baseModel, thinking: suffixThinking } = parseModel(body.model);
    const thinking: ThinkingLevel = body.reasoning_effort ?? suffixThinking;
    const upstreamEffort = thinkingToUpstream(thinking);

    // Layer 1: build a request-scoped redactor and rewrite any PII in the
    // outbound messages before they reach the upstream. The same redactor
    // produces the restorer used to put originals back into the response.
    const redactor = config.redact.enabled
      ? new Redactor(config.redact.categories)
      : null;
    const messagesForUpstream = redactor
      ? redactMessages(body.messages, redactor)
      : body.messages;

    const upstreamBody: Record<string, unknown> = {
      model: baseModel,
      messages: messagesForUpstream,
      stream: true,
    };

    if (body.tools && body.tools.length > 0) {
      upstreamBody.tools = body.tools;
      upstreamBody.tool_choice = body.tool_choice || 'auto';
    }

    if (upstreamEffort) {
      upstreamBody.reasoning_effort = upstreamEffort;
    }

    if (body.max_tokens) upstreamBody.max_tokens = body.max_tokens;
    if (body.max_completion_tokens) upstreamBody.max_completion_tokens = body.max_completion_tokens;
    if (body.temperature !== undefined) upstreamBody.temperature = body.temperature;
    if (body.top_p !== undefined) upstreamBody.top_p = body.top_p;
    if (body.stop) upstreamBody.stop = body.stop;
    if (body.presence_penalty !== undefined) upstreamBody.presence_penalty = body.presence_penalty;
    if (body.frequency_penalty !== undefined) upstreamBody.frequency_penalty = body.frequency_penalty;

    let upstreamResponse: Response;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    reply.raw.on('close', onAbort);
    const timeout = AbortSignal.timeout(config.upstreamTimeoutMs);
    // Combine client-disconnect and timeout aborts.
    const race = AbortSignal.any?.([ac.signal, timeout]) ?? timeout;
    try {
      upstreamResponse = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(upstreamBody),
        signal: race,
      });
    } catch (err: unknown) {
      if (ac.signal.aborted) {
        // Client already gone; nothing more to send.
        return reply;
      }
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({
        error: {
          message: `Failed to connect to upstream: ${msg}`,
          type: 'proxy_error',
          code: 502,
        },
      });
    } finally {
      reply.raw.off('close', onAbort);
    }

    let errorBody: string | null = null;
    if (!upstreamResponse.ok) {
      try {
        // Cap the error body so a huge upstream error page cannot exhaust
        // memory. 8 KiB is plenty to surface a useful diagnostic.
        errorBody = await readLimited(upstreamResponse, 8 * 1024);
      } catch {
        errorBody = 'Unknown upstream error';
      }
      return reply.status(upstreamResponse.status).send({
        error: {
          message: `Upstream error (${upstreamResponse.status}): ${errorBody}`,
          type: 'upstream_error',
          code: upstreamResponse.status,
        },
      });
    }

    if (isStream) {
      return handleStreaming(
        upstreamResponse,
        reply,
        body.stream_options?.include_usage,
        ac.signal,
        redactor?.buildRestorer() ?? null,
      );
    }

    return handleNonStreaming(upstreamResponse, reply, ac.signal, redactor?.buildRestorer() ?? null);
  });
}

async function handleStreaming(
  upstreamResponse: Response,
  reply: FastifyReply,
  includeUsage?: boolean,
  abortSignal?: AbortSignal,
  restorer: import('../utils/redact.js').Restorer | null = null,
) {
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
    raw.writeHead(502, { 'Content-Type': 'application/json' });
    raw.end(JSON.stringify({
      error: { message: 'Upstream returned no body', type: 'upstream_error', code: 502 },
    }));
    return;
  }
  const decoder = new TextDecoder();
  const transformer = new StreamTransformer();
  if (restorer) transformer.setRestorer(restorer);
  let buffer = '';
  const suffixStripper = new SuffixStripper();
  let lastId = '';
  let lastModel = '';
  let lastCreated = 0;

  try {
    while (true) {
      if (abortSignal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          const tail = suffixStripper.flush();
          if (tail) {
            raw.write(`data: ${JSON.stringify({
              id: lastId,
              object: 'chat.completion.chunk',
              created: lastCreated || Math.floor(Date.now() / 1000),
              model: lastModel,
              choices: [{ index: 0, delta: { content: tail }, finish_reason: null }],
            })}\n\n`);
          }
          raw.write('data: [DONE]\n\n');
          continue;
        }

        let parsed: UpstreamChunk;
        try {
          parsed = JSON.parse(data) as UpstreamChunk;
        } catch {
          continue;
        }

        if (
          !includeUsage &&
          parsed.usage &&
          (!parsed.choices || parsed.choices.length === 0)
        ) {
          continue;
        }

        const transformed = transformer.transform(parsed);
        if (!transformed) continue;

        if (transformed.id) lastId = transformed.id;
        if (transformed.model) lastModel = transformed.model;
        if (transformed.created) lastCreated = transformed.created;

        if (transformed.choices?.length) {
          const delta = transformed.choices[0].delta;
          if (delta?.content) {
            const clean = suffixStripper.push(delta.content);
            if (clean) {
              delta.content = clean;
            } else {
              delete delta.content;
            }
          }

          if (transformed.choices[0].finish_reason) {
            const tail = suffixStripper.flush();
            if (tail) {
              delta!.content = (delta!.content || '') + tail;
            }
          }

          if (
            Object.keys(transformed.choices[0].delta || {}).length === 0 &&
            !transformed.choices[0].finish_reason
          ) {
            continue;
          }
        }

        raw.write(`data: ${JSON.stringify(transformed)}\n\n`);
      }
    }

    // Safety flush: if the stream ended without [DONE]/finish_reason, release
    // any remaining suffix-buffered content (without the suffix).
    const safetyTail = suffixStripper.flush();
    if (safetyTail) {
      raw.write(`data: ${JSON.stringify({
        id: lastId,
        object: 'chat.completion.chunk',
        created: lastCreated || Math.floor(Date.now() / 1000),
        model: lastModel,
        choices: [{ index: 0, delta: { content: safetyTail }, finish_reason: null }],
      })}\n\n`);
    }

    // End-of-stream: release any text the PII restorer held back for a token
    // that may have been split across chunks.
    if (restorer) {
      const flushed = transformer.flushRestorer();
      if (flushed) raw.write(`data: ${JSON.stringify(flushed)}\n\n`);
    }
  } catch (err: unknown) {
    if (abortSignal?.aborted) {
      // Client disconnected; suppress the error and stop the stream.
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      raw.write(`data: ${JSON.stringify({
        error: { message: `Stream error: ${msg}`, type: 'stream_error' },
      })}\n\n`);
    }
  } finally {
    if (abortSignal?.aborted) {
      // Stop draining the upstream so it can be released promptly.
      try { await reader.cancel(); } catch { /* ignore */ }
    }
    try { raw.end(); } catch { /* ignore */ }
  }
}

async function handleNonStreaming(
  upstreamResponse: Response,
  reply: FastifyReply,
  abortSignal?: AbortSignal,
  restorer: import('../utils/redact.js').Restorer | null = null,
) {
  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
    return reply.status(502).send({
      error: { message: 'Upstream returned no body', type: 'upstream_error', code: 502 },
    });
  }
  const decoder = new TextDecoder();
  const transformer = new StreamTransformer();
  let buffer = '';

  let finalId = '';
  let finalModel = '';
  let finalCreated = Math.floor(Date.now() / 1000);
  let finalContent = '';
  let finalReasoning = '';
  const finalToolCalls: ToolCallAccumulator[] = [];
  let finalFinishReason: string | null = null;
  let finalUsage: Record<string, unknown> | null = null;

  try {
    while (true) {
      if (abortSignal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        let parsed: UpstreamChunk;
        try {
          parsed = JSON.parse(data) as UpstreamChunk;
        } catch {
          continue;
        }

        if (parsed.id) finalId = parsed.id;
        if (parsed.created) finalCreated = parsed.created;
        if (parsed.model) finalModel = parsed.model;
        if (parsed.usage) finalUsage = parsed.usage;

        const choice = parsed.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) finalFinishReason = choice.finish_reason;

        const delta = choice.delta || {};
        if (delta.content) {
          const { content, reasoning } = transformer.thinkParser.push(delta.content);
          finalContent += content || '';
          finalReasoning += reasoning || '';
        }
        if (delta.reasoning_content) finalReasoning += delta.reasoning_content;
        if (delta.reasoning) finalReasoning += delta.reasoning;
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx: number = tc.index ?? 0;
            if (!finalToolCalls[idx]) {
              finalToolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            }
            if (tc.id) finalToolCalls[idx].id = tc.id;
            if (tc.function?.name) finalToolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) finalToolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }
    }
  } catch (err: unknown) {
    if (abortSignal?.aborted) {
      // Client disconnected; abort the upstream read rather than returning a
      // partial 200 response that the client will never see.
      try { await reader.cancel(); } catch { /* ignore */ }
      return reply;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return reply.status(502).send({
      error: { message: `Upstream stream error: ${msg}`, type: 'upstream_error', code: 502 },
    });
  }

  const toolCallsClean = finalToolCalls
    .filter(Boolean)
    .map((t, i) => ({
      id: t.id || `call_${i}`,
      type: 'function' as const,
      function: { name: t.function.name, arguments: t.function.arguments },
    }));

  // Strip upstream-injected suffix before PII restoration.
  const cleanedContent = stripTextSuffix(finalContent);
  // Restore redacted PII tokens to their originals in the assembled content.
  const restoredContent = restorer ? restorer.restoreAll(cleanedContent) : cleanedContent;

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: restoredContent || null,
  };

  if (finalReasoning) {
    message.reasoning_content = finalReasoning;
  }

  if (toolCallsClean.length > 0) {
    message.tool_calls = toolCallsClean;
  }

  return reply.send({
    id: finalId || `chatcmpl-${randomId()}`,
    object: 'chat.completion',
    created: finalCreated,
    model: finalModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finalFinishReason || (toolCallsClean.length > 0 ? 'tool_calls' : 'stop'),
        logprobs: null,
      },
    ],
    usage: finalUsage || undefined,
  });
}

function randomId(): string {
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('');
}

/**
 * Reads at most `limit` bytes from a Response body, decoding as UTF-8. Useful
 * for surfacing upstream error bodies without trusting them to be small.
 */
async function readLimited(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let read = 0;
  try {
    while (read < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      read += value.byteLength;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  return out.length > limit ? out.slice(0, limit) : out;
}

/**
 * Walks the request `messages` and redacts PII from every textual part: the
 * plain `content` string, each `text` part of a multipart `content`, and the
 * `tool_calls.function.arguments` JSON string (best-effort — arguments may be
 * arbitrary JSON, so we redact the raw string before it's re-stringified by the
 * upstream). Returns a new messages array; the input is not mutated.
 *
 * Tool-message `content` is also redacted since assistant tool results can
 * echo PII back.
 */
function redactMessages(
  messages: ChatCompletionRequestType['messages'],
  redactor: Redactor,
): ChatCompletionRequestType['messages'] {
  return messages.map((msg: ChatMessageType) => {
    const out: Record<string, unknown> = { ...msg };

    if (typeof msg.content === 'string') {
      out.content = redactor.redact(msg.content);
    } else if (Array.isArray(msg.content)) {
      out.content = msg.content.map((part) =>
        part.type === 'text' ? { ...part, text: redactor.redact(part.text) } : part,
      );
    }

    if (msg.tool_calls) {
      out.tool_calls = msg.tool_calls.map((tc) => ({
        ...tc,
        function: {
          ...tc.function,
          arguments: redactor.redact(tc.function.arguments),
        },
      }));
    }

    if (typeof msg.name === 'string') {
      out.name = redactor.redact(msg.name);
    }

    return out as ChatMessageType;
  });
}
