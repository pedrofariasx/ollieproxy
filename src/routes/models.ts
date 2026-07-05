import { FastifyInstance, FastifyReply } from 'fastify';
import { getModels } from '../utils/upstream-models.js';

export async function modelsRoutes(app: FastifyInstance) {
  app.get('/v1/models', async (_request, _reply) => {
    const data = await getModels();
    return { object: 'list', data };
  });

  app.get('/v1/models/:model', async (request, reply: FastifyReply) => {
    const { model } = request.params as { model: string };
    const data = await getModels();
    const entry = data.find((m) => m.id === model);
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
