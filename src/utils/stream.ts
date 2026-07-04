const THINK_OPEN = /\[\[\s*think\s*\]\]/i;
const THINK_CLOSE = /\[\s*\/\s*think\s*\]\]/i;

interface ParseResult {
  content: string;
  reasoning: string;
}

function parseThinking(s: string): ParseResult {
  const openMatch = s.match(THINK_OPEN);
  if (!openMatch) {
    return { content: s, reasoning: '' };
  }

  const afterOpen = s.slice(openMatch.index! + openMatch[0].length);
  const closeMatch = afterOpen.match(THINK_CLOSE);

  if (!closeMatch) {
    return {
      content: s.slice(0, openMatch.index!),
      reasoning: afterOpen,
    };
  }

  return {
    content:
      s.slice(0, openMatch.index!) +
      afterOpen.slice(closeMatch.index! + closeMatch[0].length),
    reasoning: afterOpen.slice(0, closeMatch.index!),
  };
}

export class ThinkParser {
  private fullText = '';
  private prevContent = '';
  private prevReasoning = '';

  push(chunk: string): { content: string; reasoning: string } {
    this.fullText += chunk;
    const { content, reasoning } = parseThinking(this.fullText);

    const newContent = content.startsWith(this.prevContent)
      ? content.slice(this.prevContent.length)
      : '';
    const newReasoning = reasoning.startsWith(this.prevReasoning)
      ? reasoning.slice(this.prevReasoning.length)
      : '';

    this.prevContent = content;
    this.prevReasoning = reasoning;

    return { content: newContent, reasoning: newReasoning };
  }

  reset() {
    this.fullText = '';
    this.prevContent = '';
    this.prevReasoning = '';
  }
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
        newDelta.content = parsed.content;
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
  }
}
