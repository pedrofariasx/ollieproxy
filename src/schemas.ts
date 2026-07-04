import { z } from 'zod';

export const FunctionDefinition = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
});

export const ToolDefinition = z.object({
  type: z.literal('function'),
  function: FunctionDefinition,
});

const ImageUrlPart = z.object({
  type: z.literal('image_url'),
  image_url: z.object({ url: z.string(), detail: z.string().optional() }),
});

const TextPart = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const ContentPart = z.union([TextPart, ImageUrlPart]);

export const ToolCall = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

export const ChatMessage = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(ContentPart)]).nullable().optional(),
  tool_calls: z.array(ToolCall).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

export const StreamOptions = z.object({
  include_usage: z.boolean().optional(),
});

export const ChatCompletionRequest = z.object({
  model: z.string(),
  messages: z.array(ChatMessage).min(1),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z.array(ToolDefinition).optional(),
  tool_choice: z.union([
    z.literal('auto'),
    z.literal('none'),
    z.literal('required'),
    z.object({
      type: z.literal('function'),
      function: z.object({ name: z.string() }),
    }),
  ]).optional(),
  reasoning_effort: z.enum(['off', 'low', 'medium', 'high', 'max']).optional(),
  stream_options: StreamOptions.optional(),
  user: z.string().optional(),
  n: z.number().int().positive().optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
});

export type ChatCompletionRequestType = z.infer<typeof ChatCompletionRequest>;
export type ChatMessageType = z.infer<typeof ChatMessage>;
export type ToolCallType = z.infer<typeof ToolCall>;
