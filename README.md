# AI Commons

AI Commons is an open-source distributed AI computing network.

It allows volunteers to contribute local AI inference, idle GPU resources,
or limited AI API usage toward large public-good workloads.

Think Folding@home, but for AI inference.

Your API credentials remain on your machine.
You control exactly how much compute or API budget may be contributed.

> [!WARNING]
> **Early MVP beta.** This is working software, but it has only been run by its
> author, on one Windows machine, against a local coordinator. There is no public
> coordinator to join yet, the desktop installer is unsigned, and the protocol
> may change without notice. Don't point it at a paid API key you aren't
> prepared to experiment with. The next section lists what has and hasn't been tested.

## Project status

| Area                                                         | State                                                                                                                                                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol, coordinator, CLI worker, validation, dashboard     | Built and tested (452 TypeScript tests)                                                                                                                                                   |
| Local inference with Ollama                                  | Verified end to end with real `qwen3:4b` on 2–3 workers                                                                                                                                   |
| Windows desktop worker (Tauri)                               | Built, unsigned NSIS installer, verified end to end once on the author's machine (43 Rust tests)                                                                                          |
| Commercial providers (OpenAI, Anthropic)                     | OpenAI live run: 101 successful `gpt-4.1-mini` calls; Anthropic adapter and secure key setup are implemented. Its bounded preflight returned HTTP 400 before inference.                   |
| Spending limits                                              | Enforced locally; live run stayed under the USD 0.25/day and USD 5/month caps.                                                                                                            |
| MVP acceptance test (10 machines, 10,000 tasks, 2 providers) | Partial local run: 127/9,987 tasks completed on one machine; full acceptance remains.                                                                                                     |
| Public coordinator / hosted service                          | **None.** You run your own coordinator.                                                                                                                                                   |
| macOS / Linux                                                | The CLI worker and coordinator are written to be portable, and CI is set up for Linux and Windows, but it runs for the first time with this publication. There's no desktop app for them. |

See [PROGRESS.md](./PROGRESS.md) for the detailed state and known gaps, and
[NEXT_STEPS.md](./NEXT_STEPS.md) for what's planned.

## What is AI Commons?

It's a coordinator that splits a large AI workload, such as classifying 10,000
scientific abstracts, into small tasks, plus workers that volunteers run on their
own machines. Each worker leases a task, runs it through a local model (Ollama)
or, if the volunteer allows it, a commercial API they pay for, validates the output,
and sends back the result. The coordinator cross-checks results from different
volunteers and publishes progress on a public dashboard.

## Why does it exist?

Useful public-good workloads (literature classification, dataset labelling,
research triage) often need more inference than one person or lab can afford.
Many people have idle GPUs or small API budgets they'd happily donate, but only
if they keep their credentials and stay in control of their spending.
Existing options usually ask you to hand over an API key. AI Commons is designed
so you never have to.

## What can I contribute?

- **Local inference.** Run [Ollama](https://ollama.com) with a model of your
  choice. It costs you only electricity.
- **A limited API budget.** Store your own key locally and set daily and monthly
  USD caps. The default cap is $0.
- **Code, reviews and ideas.** See [How do I contribute code?](#how-do-i-contribute-code).

## How does it work?

```text
project owner ──▶ coordinator ──lease──▶ worker ──▶ Ollama / your API key
                      ▲                    │
                      └──── result ◀───────┘  (validated locally, then again by the coordinator)
```

- **Projects are data, not code.** A project is a JSON definition: input and output
  JSON Schemas, a `{{field}}` prompt template, and validation settings. Workers
  never run code supplied by a project or the coordinator, and you can inspect
  every prompt before it is sent (`aicommons inspect <project>`).
- **Tasks are leased** for a limited time and extended while running. If a worker
  disappears, its task goes back to the queue.
- **Validation:** every result must match the project's output schema. Projects can
  require **consensus**: two or more different workers must agree on key fields,
  and a disagreement triggers another replica. No model judges another model's output.
- **Contribution accounting** records tasks, tokens, local inference time and API
  cost. It shows on the dashboard as AI Compute Units (1 ACU = $0.001 of API
  spend).

More detail is in [docs/architecture.md](./docs/architecture.md) and
[docs/protocol.md](./docs/protocol.md).

## Does AI Commons receive my API keys?

**No.** Keys are stored only in your operating system's credential store
(Windows Credential Manager, macOS Keychain, or Linux Secret Service), and the
worker sends them only to the provider you configured. The protocol has no
field for them.

- If the credential store is unavailable, the worker refuses to run. There's no
  plaintext fallback.
- Keys are never accepted as command-line arguments, never logged, and never
  written to config files. Tests check all of this, and the desktop E2E run
  confirmed a test key appeared only in Credential Manager.
- Remote provider endpoints must use `https://` (plain http is allowed only for
  localhost).

See [docs/security.md](./docs/security.md) for the full threat model.

## Can it spend unlimited money?

**No, by design.** A bounded OpenAI live run stayed within locally enforced spending caps; the Anthropic preflight stopped before inference and incurred no model usage.

- Limits are enforced **on your machine**, not by the coordinator. The default is
  $0/day and $0/month, which means no paid calls.
- Before every paid call, the worker reserves the **maximum possible** cost of
  that call against your daily and monthly limits in a local SQLite ledger. If
  it doesn't fit, the call is not made.
- Afterwards the reservation is settled to the real cost. Failed calls are charged
  in full unless the provider confirms they weren't billed. Reservations left
  behind by a crash count as spent.
- Models without a configured price are refused.
- Projects can mark tasks `local_models_only`, and you choose which projects, if
  any, may use your paid provider at all.

## What projects are available?

There's no public coordinator yet, so there are no live projects to join. The repository
includes one example, **Scientific Abstract Classification**
([examples/abstract-classification](./examples/abstract-classification)), with 20
real arXiv abstracts and a script to fetch 10,000 more. It's the workload used for
the end-to-end tests.

## How do I run a worker?

You need a coordinator to connect to. To try everything locally, see
[Run it all locally](#run-it-all-locally).

### Windows desktop app (beta)

There's no published release yet. Build the unsigned installer from source:

```sh
pnpm install
pnpm build
pnpm --filter @ai-commons/desktop stage   # needs Node 24; bundles the Node runtime
cd apps/desktop && cargo tauri build      # needs the Rust toolchain
```

The installer is written to
`apps/desktop/src-tauri/target/release/bundle/nsis/`. It's unsigned, so Windows
SmartScreen will warn you. In the app:

1. Open **Settings**, enter the coordinator URL, and click **Detect models** under
   Ollama.
2. Tick a model and click **Save**.
3. The **Status** tab shows the connection, the current task, today's
   contribution and your spend against your limits.
4. You can pause, contribute only while the PC is idle, or close the window to
   keep contributing from the tray.

More in [docs/desktop.md](./docs/desktop.md).

### Command line (Windows, macOS, Linux)

```sh
pnpm install && pnpm build
node apps/worker/dist/cli.js configure --coordinator-url https://coordinator.example.org \
  --enable ollama --models ollama=qwen3:4b --mode active --categories all
node apps/worker/dist/cli.js start
```

Other commands are `status`, `pause`, `resume`, `usage`, `inspect <project>` and
`set-key <provider>` (you type the key at a hidden prompt; it's never passed as
an argument). See [docs/worker.md](./docs/worker.md).

## How do I create a project?

Define it with `@ai-commons/project-sdk` and load tasks as JSONL:

```ts
import { defineProject } from '@ai-commons/project-sdk';

export default defineProject({
  id: 'abstract-classification',
  name: 'Scientific Abstract Classification',
  version: '1.0.0',
  category: 'science',
  input_schema: {/* JSON Schema for each task */},
  output_schema: {/* JSON Schema the model must return */},
  prompt: { system: 'Respond with JSON only.', user: 'Title: {{title}}\n\n{{abstract}}' },
  requirements: {
    capability: 'text_generation',
    minimum_context_window: 8192,
    max_output_tokens: 300,
    local_models_only: false,
  },
  validation: { mode: 'consensus', replication_factor: 2, consensus_fields: ['field'] },
});
```

`defineProject` validates the definition up front: the schemas, the placeholders
and the consensus fields. See [docs/project-sdk.md](./docs/project-sdk.md) and the
example's `scripts/publish.ts`.

## Run it all locally

Requires Node.js ≥ 22.18, pnpm 10 and Docker. Ollama is optional but needed for real inference.

```sh
docker compose up -d        # PostgreSQL on localhost:55432
pnpm install
pnpm build
pnpm test

# Coordinator + dashboard on http://localhost:8080
DATABASE_URL=postgres://aicommons:aicommons@localhost:55432/aicommons \
ADMIN_TOKEN=<at least 24 random characters> \
DASHBOARD_DIR=apps/dashboard/dist \
node apps/coordinator/dist/index.js

# Publish the demo project (20 abstracts)
cd examples/abstract-classification
COORDINATOR_URL=http://localhost:8080 ADMIN_TOKEN=<same> node scripts/publish.ts data/sample.jsonl
```

Then start one or more workers against `http://localhost:8080`. The demo needs two
distinct workers to reach consensus.

## Repository layout

| Path                   | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `packages/protocol`    | Shared wire schemas and types (TypeBox / JSON Schema)                |
| `packages/validators`  | Input, output and project-schema checks; consensus                   |
| `packages/providers/*` | Provider adapters: `core` interface, `ollama`, `openai`, `anthropic` |
| `packages/project-sdk` | `defineProject`, admin client, JSONL loader                          |
| `apps/coordinator`     | Fastify + PostgreSQL coordinator (leasing, validation, accounting)   |
| `apps/worker`          | Volunteer worker: CLI (`aicommons`) and the desktop app's daemon     |
| `apps/desktop`         | Windows desktop worker: Tauri shell + web UI                         |
| `apps/dashboard`       | Public web dashboard                                                 |
| `examples/*`           | Example workloads                                                    |
| `docs/`                | Architecture, protocol, security, worker, desktop, providers and SDK |

The full product and build specification is [`Open Compute.md`](./Open%20Compute.md).

## How do I contribute code?

Contributions are welcome, but expect rough edges and fast-moving internals at this stage.

1. Read [AGENTS.md](./AGENTS.md). It holds the engineering rules for humans
   and AI agents alike: strict TypeScript, validate every network input, never
   log or persist secrets, enforce limits locally, and never execute
   project-supplied code.
2. Open an issue first for anything non-trivial, whether it's a bug, feature,
   provider request or project proposal.
3. Before sending a pull request, run `pnpm format`, `pnpm lint`, `pnpm typecheck`
   and `pnpm test`. For desktop changes, also run `cargo test` in
   `apps/desktop/src-tauri`.

Use GitHub Discussions for architecture ideas and general questions.

**Security issues:** don't open a public issue. Report them privately through
this repository's **Security → Report a vulnerability** page.

## License

Apache License 2.0. See [LICENSE](./LICENSE).
