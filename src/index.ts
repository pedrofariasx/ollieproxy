import { config } from './config.js';
import { buildApp } from './server.js';

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`OllieProxy running at http://${config.host}:${config.port}`);
    app.log.info(`Upstream: ${config.upstreamUrl}`);
    app.log.info(`Models: GET  http://localhost:${config.port}/v1/models`);
    app.log.info(`Chat:   POST http://localhost:${config.port}/v1/chat/completions`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`Received ${signal}, shutting down...`);
    try {
      await app.close();
      app.log.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
