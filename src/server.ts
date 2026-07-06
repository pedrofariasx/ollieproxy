import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { getCachedStatus } from './utils/status.js';
import { chatRoutes } from './routes/chat.js';
import { modelsRoutes } from './routes/models.js';
import { installAuth } from './keys/plugin.js';

export async function buildApp() {
  const app = Fastify({ logger: true, bodyLimit: config.bodyLimitBytes });

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  const healthHandler = async () => {
    const status = await getCachedStatus();
    if (!status) return { status: 'ok', upstream: 'unreachable' };
    const total = status.models.length;
    const ok = status.models.filter((m) => m.status === 'ok').length;
    return {
      status: status.overall,
      uptime_seconds: status.uptimeSeconds,
      started_at: status.startedAt,
      checked_at: status.checkedAt,
      services: status.services,
      models: status.models,
      models_ok: ok,
      models_total: total,
    };
  };

  app.get('/health', healthHandler);
  app.get('/v1/health', healthHandler);

  // API-key auth + per-key RPM rate limiting, opt-in via AUTH_ENABLED=1.
  // Attached as a root-level preHandler (not an encapsulated plugin) so it
  // guards every route registered afterwards, including /v1/models.
  if (config.auth.enabled) {
    await installAuth(app);
  }

  await app.register(modelsRoutes);
  await app.register(chatRoutes);

  return app;
}
