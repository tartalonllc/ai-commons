# Project SDK

`@ai-commons/project-sdk` lets project owners define workloads and load tasks
into a coordinator without touching coordinator code.

## Defining a project

```ts
import { defineProject } from '@ai-commons/project-sdk';

export default defineProject({
  id: 'abstract-classification',
  name: 'Scientific Abstract Classification',
  description: '…',
  version: '1.0.0',
  category: 'science',
  input_schema: { type: 'object', required: ['title', 'abstract'], properties: { … } },
  output_schema: { type: 'object', required: ['field'], properties: { … } },
  prompt: {
    system: 'You classify scientific abstracts. Respond with JSON only.',
    user: 'Title: {{title}}\n\nAbstract:\n{{abstract}}',
  },
  requirements: {
    capability: 'text_generation',
    minimum_context_window: 8192,
    max_output_tokens: 300,
    local_models_only: false,
  },
  validation: { mode: 'consensus', replication_factor: 2, consensus_fields: ['field'] },
});
```

`defineProject` validates the definition and throws `ProjectDefinitionError`
listing **every** problem at once:

- the definition matches the protocol `ProjectDefinition` schema;
- both JSON Schemas pass `checkProjectSchema` (no `$ref`, no unknown keywords,
  bounded nesting);
- every `{{placeholder}}` in the prompt names an `input_schema` property;
- consensus mode declares `consensus_fields`, each naming an `output_schema` property.

A JSON manifest with the same shape can be loaded with
`loadProjectManifest(path)`.

### Prompts are templates, not code

The spec sketches a `buildPrompt(task)` function, but project code never runs on
volunteer machines (spec §42). The prompt is data: `system` and `user` strings
whose `{{field}}` placeholders the worker fills from the task payload with
`renderPrompt` from `@ai-commons/protocol`. Volunteers can inspect exactly what
will be sent to their provider (spec §44). See [protocol.md](./protocol.md).

Result validation is likewise declarative: the output JSON Schema plus the
consensus settings. Custom validation functions run only on the owner's side,
never on workers.

## Loading tasks

```ts
import { CoordinatorAdminClient, readJsonl } from '@ai-commons/project-sdk';

const client = new CoordinatorAdminClient({ baseUrl, adminToken });
await client.createProject(project);

async function* tasks() {
  for await (const row of readJsonl('data/abstracts.jsonl')) {
    const { id, ...payload } = row;
    yield { id: String(id), payload };
  }
}

const result = await client.ingestTasks(project, tasks(), { skipInvalid: true });
```

`ingestTasks` checks each payload against the project's `input_schema` and the
1 MB payload limit **before** sending, then submits in batches of up to 1,000.
Invalid tasks throw `TaskPayloadError`, or with `skipInvalid: true` are reported
in `result.skipped`. Batches already sent are not rolled back.

All responses are validated against protocol schemas; failures and coordinator
errors throw `CoordinatorAdminError` (with `status` and `code`).

| Method                      | Endpoint                          |
| --------------------------- | --------------------------------- |
| `createProject(def)`        | `POST /api/v1/projects`           |
| `getProject(id)`            | `GET /api/v1/projects/:id`        |
| `ingestTasks(project, ...)` | `POST /api/v1/projects/:id/tasks` |
| `getProjectStats(id)`       | `GET /api/v1/projects/:id/stats`  |

See `examples/abstract-classification` for a complete workload.
