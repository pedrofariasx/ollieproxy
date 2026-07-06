import { FastifyInstance, FastifyReply } from 'fastify';
import { getModels } from '../utils/upstream-models.js';
import { getCachedStatus, ModelStatus } from '../utils/status.js';

const SUFFIX_LEVELS = ['low', 'medium', 'high', 'max'];

function baseModelId(variantId: string): string {
  for (const lvl of SUFFIX_LEVELS) {
    const suffix = `-${lvl}`;
    if (variantId.endsWith(suffix)) {
      return variantId.slice(0, -suffix.length);
    }
  }
  return variantId;
}

export async function modelsRoutes(app: FastifyInstance) {
  app.get('/v1/models', async (_request, _reply) => {
    const [models, status] = await Promise.all([getModels(), getCachedStatus()]);
    const statusMap = new Map<string, ModelStatus>();
    if (status) {
      for (const m of status.models) {
        statusMap.set(m.id, m);
      }
    }

    const data = models.map((m) => {
      const baseId = baseModelId(m.id);
      const ms = statusMap.get(baseId);
      const entry: Record<string, unknown> = { ...m };
      if (ms) {
        entry.status = ms.status;
        entry.latency_ms = ms.latencyMs;
      }
      return entry;
    });

    return { object: 'list', data };
  });

  app.get('/v1/models/:model', async (request, reply: FastifyReply) => {
    const { model } = request.params as { model: string };
    const [models, status] = await Promise.all([getModels(), getCachedStatus()]);
    const statusMap = new Map<string, ModelStatus>();
    if (status) {
      for (const m of status.models) {
        statusMap.set(m.id, m);
      }
    }

    const entry = models.find((m) => m.id === model);
    if (!entry) {
      return reply.status(404).send({
        error: {
          message: `Model '${model}' not found`,
          type: 'invalid_request_error',
          code: 404,
        },
      });
    }

    const baseId = baseModelId(entry.id);
    const ms = statusMap.get(baseId);
    const result: Record<string, unknown> = { ...entry };
    if (ms) {
      result.status = ms.status;
      result.latency_ms = ms.latencyMs;
    }
    return result;
  });
}
