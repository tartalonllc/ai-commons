// Creates the demo project on a coordinator and ingests abstracts from JSONL.
// Usage: COORDINATOR_URL=http://localhost:3000 ADMIN_TOKEN=... node scripts/publish.ts [file.jsonl]
import type { JsonObject, TaskInput } from '@ai-commons/protocol';
import { CoordinatorAdminClient, CoordinatorAdminError, readJsonl } from '@ai-commons/project-sdk';
import project from '../project.ts';

const baseUrl = process.env['COORDINATOR_URL'];
const adminToken = process.env['ADMIN_TOKEN'];
if (!baseUrl || !adminToken) {
  console.error('COORDINATOR_URL and ADMIN_TOKEN must be set');
  process.exit(1);
}
const file = process.argv[2] ?? 'data/sample.jsonl';

const client = new CoordinatorAdminClient({ baseUrl, adminToken });

try {
  await client.createProject(project);
  console.log(`Created project ${project.id}`);
} catch (error) {
  if (error instanceof CoordinatorAdminError && error.status === 409) {
    console.log(`Project ${project.id} already exists; ingesting tasks`);
  } else {
    throw error;
  }
}

async function* tasks(): AsyncGenerator<TaskInput> {
  for await (const row of readJsonl(file)) {
    const { id, ...payload }: JsonObject = row;
    yield typeof id === 'string' ? { id, payload } : { payload };
  }
}

const result = await client.ingestTasks(project, tasks(), {
  skipInvalid: true,
  batchSize: 250,
  onBatch: ({ created, skipped }) => console.log(`created ${created}, skipped ${skipped}`),
});
console.log(`Done: ${result.created} tasks created, ${result.skipped.length} skipped`);
for (const skip of result.skipped.slice(0, 10)) {
  console.warn(`  line #${skip.index + 1}: ${skip.issues.map((i) => i.message).join('; ')}`);
}
