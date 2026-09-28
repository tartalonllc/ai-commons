import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { connect, runMigrations } from './db/client.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const handle = connect(config.databaseUrl);
  await runMigrations(handle.db);
  const app = await buildApp({ config, db: handle.db });

  const shutdown = async () => {
    await app.close();
    await handle.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await app.listen({ port: config.port, host: config.host });
}

await main();
