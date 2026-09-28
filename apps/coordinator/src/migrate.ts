import { connect, runMigrations } from './db/client.js';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const handle = connect(url, 1);
try {
  await runMigrations(handle.db);
  console.log('Migrations applied');
} finally {
  await handle.close();
}
