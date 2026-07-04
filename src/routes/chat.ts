import { FastifyInstance, FastifyReply } from 'fastify';
import { ChatCompletionRequest } from '../schemas.js';
import { config } from '../config.js';
import { StreamTransformer, UpstreamChunk } from '../utils/stream.js';

const CHAT_URL = `${config.upstreamUrl}/api/chat`;

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

    const upstreamBody: Record<string, unknown> = {
      model: body.model,
      messages: body.messages,
      stream: true,
    };

    if (body.tools && body.tools.length > 0) {
      upstreamBody.tools = body.tools;
      upstreamBody.tool_choice = body.tool_choice || 'auto';
    }

    if (body.reasoning_effort) {
      upstreamBody.reasoning_effort = body.reasoning_effort;
    }

    if (body.max_tokens) upstreamBody.max_tokens = body.max_tokens;
    if (body.max_completion_tokens) upstreamBody.max_completion_tokens = body.max_completion_tokens;
    if (body.temperature !== undefined) upstreamBody.temperature = body.temperature;
    if (body.top_p !== undefined) upstreamBody.top_p = body.top_p;
    if (body.stop) upstreamBody.stop = body.stop;
    if (body.presence_penalty !== undefined) upstreamBody.presence_penalty = body.presence_penalty;
    if (body.frequency_penalty !== undefined) upstreamBody.frequency_penalty = body.frequency_penalty;

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({
        error: {
          message: `Failed to connect to upstream: ${msg}`,
          type: 'proxy_error',
          code: 502,
        },
      });
    }

    let errorBody: string | null = null;
    if (!upstreamResponse.ok) {
      try {
        errorBody = await upstreamResponse.text();
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
      return handleStreaming(upstreamResponse, reply, body.stream_options?.include_usage);
    }

    return handleNonStreaming(upstreamResponse, reply);
  });
}

async function handleStreaming(
  upstreamResponse: Response,
  reply: FastifyReply,
  includeUsage?: boolean,
) {
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const reader = upstreamResponse.body!.getReader();
  const decoder = new TextDecoder();
  const transformer = new StreamTransformer();
  let buffer = '';

  try {
    while (true) {
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
        if (transformed) {
          raw.write(`data: ${JSON.stringify(transformed)}\n\n`);
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    raw.write(`data: ${JSON.stringify({
      error: { message: `Stream error: ${msg}`, type: 'stream_error' },
    })}\n\n`);
  } finally {
    try { raw.end(); } catch { /* ignore */ }
  }
}

async function handleNonStreaming(upstreamResponse: Response, reply: FastifyReply) {
  const reader = upstreamResponse.body!.getReader();
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

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: finalContent || null,
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
