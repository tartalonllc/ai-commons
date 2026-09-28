import { connect, runMigrations } from '../src/db/client.js';
import { TEST_DATABASE_URL } from './harness.js';

export default async function setup(): Promise<void> {
  const handle = connect(TEST_DATABASE_URL, 1);
  try {
    await handle.pool.query(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;',
    );
    await runMigrations(handle.db);
  } catch (error) {
    throw new Error(
      `Coordinator tests need Postgres at ${TEST_DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}. ` +
        'Start it with `docker compose up -d` from the repo root.',
      { cause: error },
    );
  } finally {
    await handle.close();
  }
}
