import { FastifyInstance } from 'fastify';

interface ModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

const MODELS: ModelEntry[] = [
  { id: 'claude-fable-5', object: 'model', created: 1740000000, owned_by: 'anthropic' },
  { id: 'claude-sonnet-5', object: 'model', created: 1740000001, owned_by: 'anthropic' },
  { id: 'claude-opus-4-8', object: 'model', created: 1740000002, owned_by: 'anthropic' },
  { id: 'glm-5.2', object: 'model', created: 1740000003, owned_by: 'zhipu' },
  { id: 'glm-5.2-fast', object: 'model', created: 1740000004, owned_by: 'zhipu' },
  { id: 'deepseek-v4-pro', object: 'model', created: 1740000005, owned_by: 'deepseek' },
  { id: 'kimi-k2.7-code', object: 'model', created: 1740000006, owned_by: 'moonshot' },
  { id: 'minimax-m3', object: 'model', created: 1740000007, owned_by: 'minimax' },
  { id: 'qwen-3.7-plus', object: 'model', created: 1740000008, owned_by: 'alibaba' },
];

export async function modelsRoutes(app: FastifyInstance) {
  app.get('/v1/models', async (_request, _reply) => {
    return {
      object: 'list',
      data: MODELS,
    };
  });

  app.get('/v1/models/:model', async (request, reply) => {
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
