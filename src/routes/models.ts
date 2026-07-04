import { FastifyInstance, FastifyReply } from 'fastify';
import { ThinkingLevel } from '../utils/model.js';

interface ModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface BaseModel {
  id: string;
  created: number;
  owned_by: string;
}

/** Thinking levels exposed as model-name suffixes; `off` is the bare base model. */
const SUFFIX_LEVELS: Exclude<ThinkingLevel, 'off'>[] = ['low', 'medium', 'high', 'max'];

const BASE_MODELS: BaseModel[] = [
  { id: 'claude-fable-5', created: 1740000000, owned_by: 'anthropic' },
  { id: 'claude-sonnet-5', created: 1740000001, owned_by: 'anthropic' },
  { id: 'claude-opus-4-8', created: 1740000002, owned_by: 'anthropic' },
  { id: 'glm-5.2', created: 1740000003, owned_by: 'zhipu' },
  { id: 'glm-5.2-fast', created: 1740000004, owned_by: 'zhipu' },
  { id: 'deepseek-v4-pro', created: 1740000005, owned_by: 'deepseek' },
  { id: 'kimi-k2.7-code', created: 1740000006, owned_by: 'moonshot' },
  { id: 'minimax-m3', created: 1740000007, owned_by: 'minimax' },
  { id: 'qwen-3.7-plus', created: 1740000008, owned_by: 'alibaba' },
];

const MODELS: ModelEntry[] = BASE_MODELS.flatMap((m) => {
  const base: ModelEntry = { id: m.id, object: 'model', created: m.created, owned_by: m.owned_by };
  const variants: ModelEntry[] = SUFFIX_LEVELS.map((lvl) => ({
    id: `${m.id}-${lvl}`,
    object: 'model',
    created: m.created,
    owned_by: m.owned_by,
  }));
  return [base, ...variants];
});

export async function modelsRoutes(app: FastifyInstance) {
  app.get('/v1/models', async (_request, _reply) => {
    return {
      object: 'list',
      data: MODELS,
    };
  });

  app.get('/v1/models/:model', async (request, reply: FastifyReply) => {
    const { model } = request.params as { model: string };
    const entry = MODELS.find((m) => m.id === model);
    if (!entry) {
      return reply.status(404).send({
        error: {
          message: `Model '${model}' not found`,
          type: 'invalid_request_error',
          code: 404,
        },
      });
    }
    return entry;
  });
}
