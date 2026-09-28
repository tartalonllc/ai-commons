# AI Commons

## Distributed Volunteer AI Compute for Public-Good Projects

**Status:** MVP Specification  
**Project Type:** Open-source distributed AI orchestration platform  
**Primary Goal:** Allow volunteers to contribute AI inference capacity, API budget, or local model compute toward shared workloads.

---

# 1. Overview

AI Commons is a distributed computing platform inspired by projects such as SETI@home and Folding@home.

Instead of volunteers contributing only CPU cycles, AI Commons allows participants to contribute:

- local AI inference
- local GPU resources
- local CPU resources
- commercial AI API usage
- limited AI API budget
- specific model access

A central coordinator breaks large workloads into small independent tasks.

Volunteer worker clients request tasks, execute them using an approved local or remote AI provider, and return structured results.

The platform tracks contributions, validates results, and aggregates completed work into useful datasets or project outputs.

The MVP should prove one core concept:

> Independent machines can safely contribute heterogeneous AI inference toward a single distributed workload.

The first release does **not** attempt to create a global marketplace, cryptocurrency, decentralized blockchain network, or universal AI protocol.

Those can remain somebody else's premature abstraction problem.

---

# 2. Core Principles

AI Commons should follow these principles from the beginning.

## 2.1 Open Source First

The core platform should be publicly available on GitHub.

Open-source components should include:

- worker agent
- coordinator
- protocol
- provider adapters
- validation framework
- contribution accounting
- project SDK
- example workloads
- documentation

Transparency is especially important because users may allow the software to consume paid API resources or execute workloads locally.

Users should be able to inspect exactly what the software does.

---

## 2.2 User-Controlled Resources

The volunteer always controls:

- which providers may be used
- which models may be used
- maximum spending
- maximum token usage
- CPU usage
- GPU usage
- execution schedule
- project categories
- whether workloads may run while the computer is active

The system must never silently exceed configured limits.

---

## 2.3 API Keys Stay Local

Commercial AI API credentials must remain on the volunteer's machine.

The central coordinator must never require volunteers to upload their provider API keys.

Example:

```text
Coordinator
     |
     | task
     v
Volunteer Agent
     |
     +--> Local API key
     |
     +--> OpenAI / Anthropic / Gemini
     |
     v
Result returned to coordinator
```

Secrets should be stored using the operating system's secure credential facilities wherever possible.

For Windows:

- Windows Credential Manager
- DPAPI

For macOS:

- Keychain

For Linux:

- Secret Service / libsecret where available

Plaintext credential storage is prohibited.

---

## 2.4 Provider Neutrality

The protocol must not depend on one AI provider.

Supported providers should eventually include:

- OpenAI
- Anthropic
- Google Gemini
- Ollama
- llama.cpp
- OpenAI-compatible endpoints
- local inference servers

The first MVP only needs:

1. Ollama
2. one commercial provider

Provider support should be implemented using adapters.

---

# 3. MVP Scope

The MVP should remain intentionally narrow.

The system needs to demonstrate:

1. A project owner creates a distributed workload.
2. The coordinator divides it into tasks.
3. Volunteer workers register with the coordinator.
4. Workers advertise supported capabilities.
5. Workers request tasks.
6. Workers execute those tasks through an AI provider.
7. Results are returned as structured JSON.
8. Results are validated.
9. Completed tasks are recorded.
10. Volunteers can see contribution statistics.
11. Spending and resource limits are enforced locally.

---

# 4. MVP Non-Goals

Do not implement the following during the MVP.

- cryptocurrency
- blockchain
- distributed consensus protocols
- payment marketplace
- token trading
- federated coordinators
- peer-to-peer task distribution
- mobile applications
- Kubernetes deployment requirements
- enterprise identity systems
- complex reputation algorithms
- AI model training
- distributed transformer training
- browser worker nodes
- automatic scientific publication
- arbitrary executable workloads
- plugin marketplace

The MVP exists to validate distributed inference.

Everything else can wait until distributed inference actually works.

---

# 5. Example MVP Workload

The initial demonstration project should be simple, measurable, and highly parallelizable.

Recommended example:

## Scientific Abstract Classification

Input:

```json
{
  "task_id": "task_000042",
  "title": "Example research paper",
  "abstract": "..."
}
```

Desired output:

```json
{
  "field": "biology",
  "topics": [
    "protein folding",
    "molecular dynamics"
  ],
  "contains_experiment": true,
  "confidence": 0.91
}
```

Each abstract is independent.

That allows thousands or millions of records to be processed independently.

---

# 6. High-Level Architecture

```text
                      AI Commons
                          |
            +-------------+-------------+
            |                           |
            v                           v
      Web Dashboard                 Coordinator
                                        |
                           +------------+------------+
                           |                         |
                           v                         v
                       Task Queue               PostgreSQL
                           |
            +--------------+--------------+
            |              |              |
            v              v              v
         Worker A       Worker B       Worker C
            |              |              |
            v              v              v
         Ollama         OpenAI         Gemini
```

---

# 7. Recommended Technology Stack

## Backend

Recommended:

- TypeScript
- Node.js
- Fastify
- PostgreSQL
- Drizzle ORM
- Redis optional

Reasons:

- strong ecosystem
- easy JSON APIs
- shared types between client/server
- straightforward SDK development
- excellent AI-provider library support
- approachable contributor experience

Alternative:

- Python
- FastAPI
- SQLAlchemy
- PostgreSQL

Python may eventually be useful for scientific workloads, but the orchestration layer should not require Python.

---

# 8. Monorepo Structure

Use a monorepo.

Recommended tooling:

- pnpm
- Turborepo
- TypeScript

Suggested repository:

```text
ai-commons/
|
+-- apps/
|   |
|   +-- coordinator/
|   |
|   +-- dashboard/
|   |
|   +-- worker/
|
+-- packages/
|   |
|   +-- protocol/
|   |
|   +-- project-sdk/
|   |
|   +-- validators/
|   |
|   +-- accounting/
|   |
|   +-- providers/
|       |
|       +-- ollama/
|       |
|       +-- openai/
|
+-- examples/
|   |
|   +-- abstract-classification/
|
+-- docs/
|   |
|   +-- architecture.md
|   |
|   +-- security.md
|   |
|   +-- protocol.md
|   |
|   +-- providers.md
|   |
|   +-- project-sdk.md
|
+-- scripts/
|
+-- tests/
|
+-- AGENTS.md
|
+-- CONTRIBUTING.md
|
+-- SECURITY.md
|
+-- LICENSE
|
+-- README.md
```

---

# 9. Core Concepts

## 9.1 Project

A Project represents a large distributed workload.

Example:

```json
{
  "id": "open-literature-demo",
  "name": "Open Literature Classification",
  "description": "Classify scientific abstracts by field and topic.",
  "version": "1.0.0"
}
```

Projects define:

- input schema
- output schema
- model requirements
- validation rules
- workload metadata
- project category

---

# 10. Task

A Task is one independently executable unit of work.

Example:

```json
{
  "id": "01JABC123",
  "project_id": "open-literature-demo",
  "payload": {
    "title": "Protein Folding Study",
    "abstract": "..."
  },
  "requirements": {
    "capability": "text_generation",
    "minimum_context_window": 8192
  }
}
```

Tasks should be immutable once assigned.

---

# 11. Worker

A Worker represents a volunteer machine.

Example capabilities:

```json
{
  "worker_id": "worker_f4e82",
  "platform": "windows",
  "providers": [
    {
      "provider": "ollama",
      "models": [
        "qwen3:8b"
      ]
    },
    {
      "provider": "openai",
      "models": [
        "configured-model"
      ]
    }
  ]
}
```

The coordinator should use capability information when assigning work.

---

# 12. Worker Registration

Worker registration flow:

```text
Worker starts
     |
     v
Generate local worker ID
     |
     v
POST /workers/register
     |
     v
Coordinator issues worker token
     |
     v
Worker sends capabilities
```

Workers should receive a coordinator authentication token.

The first MVP does not require human user accounts.

---

# 13. Task Lifecycle

Task states:

```text
pending
   |
   v
leased
   |
   +--> completed
   |
   +--> expired
   |
   +--> failed
```

Recommended state enum:

```text
PENDING
LEASED
COMPLETED
FAILED
CANCELLED
```

---

# 14. Task Leasing

Workers should poll for work.

Example:

```http
POST /v1/tasks/lease
```

Request:

```json
{
  "worker_id": "worker_f4e82",
  "capabilities": {
    "text_generation": true
  }
}
```

Response:

```json
{
  "task": {
    "id": "task_000042",
    "project_id": "open-literature-demo",
    "payload": {},
    "expires_at": "..."
  }
}
```

Leases prevent tasks from remaining permanently assigned to disconnected machines.

Recommended initial lease:

```text
15 minutes
```

Workers should be able to request extensions.

---

# 15. Worker Execution Pipeline

```text
Task received
     |
     v
Validate project definition
     |
     v
Select compatible provider
     |
     v
Check local limits
     |
     v
Construct model request
     |
     v
Execute inference
     |
     v
Validate JSON schema
     |
     v
Submit result
```

---

# 16. Provider Adapter Interface

All providers should implement a shared interface.

Pseudo-interface:

```typescript
interface AIProvider {
  id: string;

  getModels(): Promise<ModelInfo[]>;

  estimateCost(
    request: InferenceRequest
  ): Promise<CostEstimate>;

  execute(
    request: InferenceRequest
  ): Promise<InferenceResult>;

  healthCheck(): Promise<ProviderHealth>;
}
```

---

# 17. Ollama Adapter

The Ollama adapter should support:

- localhost Ollama server
- model discovery
- chat generation
- structured JSON responses
- timeout
- cancellation
- token metrics when available

Default endpoint:

```text
http://localhost:11434
```

No Ollama API credential should be required.

---

# 18. Commercial Provider Adapter

The first commercial adapter may support OpenAI or another major AI API provider.

Required features:

- local credential storage
- model selection
- token accounting
- cost estimation
- timeout
- retry policy
- structured output
- rate-limit handling

Provider-specific logic must remain isolated inside the adapter.

---

# 19. Resource Limits

This is one of the most important components of the project.

The worker must enforce resource limits independently of the coordinator.

Example configuration:

```yaml
limits:

  api:
    daily_usd: 0.25
    monthly_usd: 5.00

  local:
    cpu_percent: 25
    gpu_percent: 50

  schedule:
    idle_only: true
```

The coordinator must never be trusted to enforce user spending limits.

---

# 20. Budget Enforcement

Before executing a commercial API request:

```text
Estimate request cost
        |
        v
Check remaining daily allowance
        |
        v
Check remaining monthly allowance
        |
        +--> insufficient
        |      |
        |      v
        |    reject
        |
        v
Execute request
        |
        v
Record actual usage
```

The worker must maintain its own local accounting database.

SQLite is suitable.

---

# 21. Worker Local Database

Recommended:

SQLite.

Tables:

```text
settings
providers
usage
tasks
results
coordinator_sessions
```

Example usage table:

```text
usage
-----------------------------
id
provider
model
input_tokens
output_tokens
estimated_cost
actual_cost
timestamp
```

---

# 22. Validation

Distributed inference produces non-deterministic output.

Validation therefore cannot rely entirely on binary equality.

The MVP should support several validation modes.

## Schema Validation

Result must satisfy the project's output JSON Schema.

---

## Deterministic Validation

Used when exact output can be verified.

Example:

```text
expected category == returned category
```

---

## Redundant Validation

Assign the same task to multiple workers.

Example:

```text
Task #521
   |
   +-- Worker A -> biology
   |
   +-- Worker B -> biology
   |
   +-- Worker C -> chemistry
```

Consensus:

```text
biology
```

---

## Reference Tasks

Projects may include hidden known-answer tasks.

These help determine whether workers return plausible results.

---

# 23. Initial Validation Strategy

For the MVP:

Each task may optionally have:

```text
replication_factor = 2
```

Two independent workers execute the same task.

If compatible structured fields agree, the task is accepted.

If they disagree:

```text
replication_factor = 3
```

A third worker acts as the tie breaker.

Avoid semantic LLM judging during the first implementation.

Keep validation deterministic wherever possible.

---

# 24. Result Submission

Endpoint:

```http
POST /v1/tasks/:taskId/results
```

Example:

```json
{
  "worker_id": "worker_f4e82",
  "provider": "ollama",
  "model": "qwen3:8b",

  "result": {
    "field": "biology",
    "topics": [
      "protein folding"
    ],
    "contains_experiment": true,
    "confidence": 0.91
  },

  "metrics": {
    "duration_ms": 3850,
    "input_tokens": 726,
    "output_tokens": 112
  }
}
```

---

# 25. Contribution Accounting

Do not use cryptocurrency-style concepts.

The MVP should track measurable contributions.

Metrics:

- tasks completed
- tasks validated
- input tokens processed
- output tokens generated
- local inference time
- API cost donated
- total execution time

Example:

```text
Worker contribution

Tasks completed:       8,214
Validated results:     7,998
Tokens processed:      14.8M
Local inference time:  63 hours
API contribution:      $7.84
```

---

# 26. AI Compute Units

A normalized contribution metric may eventually be useful.

For the MVP, call it:

```text
AI Compute Units
```

Do not attempt scientifically precise normalization initially.

Possible baseline:

```text
1 ACU = $0.001 equivalent AI compute
```

For paid APIs:

```text
ACU = actual API cost / 0.001
```

For local inference, record raw metrics separately until a defensible normalization system exists.

Do not fake precision.

---

# 27. Coordinator Database

Recommended database:

PostgreSQL.

Initial tables:

```text
projects

workers

worker_capabilities

tasks

task_leases

results

validations

contributions
```

---

# 28. Projects Table

Suggested fields:

```text
id
slug
name
description
version
input_schema
output_schema
validation_mode
replication_factor
status
created_at
updated_at
```

---

# 29. Tasks Table

Suggested fields:

```text
id
project_id
payload
status
priority
replication_factor
created_at
completed_at
```

---

# 30. Task Leases

Fields:

```text
id
task_id
worker_id
leased_at
expires_at
status
```

Use database transactions when issuing leases.

Do not allow two workers to accidentally receive the same lease unless replication explicitly requires it.

---

# 31. Results Table

Fields:

```text
id
task_id
worker_id
provider
model
result
input_tokens
output_tokens
duration_ms
created_at
```

---

# 32. API Design

Prefix:

```text
/api/v1
```

Initial endpoints:

```text
POST /workers/register

POST /workers/heartbeat

POST /tasks/lease

POST /tasks/:id/extend

POST /tasks/:id/result

POST /tasks/:id/fail

GET /projects

GET /projects/:id

GET /workers/:id/stats
```

Administrative/project endpoints:

```text
POST /projects

POST /projects/:id/tasks

GET /projects/:id/stats
```

---

# 33. Worker Heartbeats

Workers should send heartbeats periodically.

Example:

```text
60 seconds
```

Heartbeat data:

```json
{
  "worker_id": "worker_f4e82",

  "status": "available",

  "providers": [
    "ollama"
  ],

  "current_tasks": 1
}
```

---

# 34. Worker Scheduling

Worker states:

```text
ACTIVE

IDLE_ONLY

PAUSED

DISABLED
```

Idle mode should eventually use OS idle detection.

For the earliest MVP, a simple active/paused setting is acceptable.

---

# 35. Desktop Worker UX

Initial Windows application screen:

```text
AI Commons

Status
--------------------------------
Connected

Current project
Open Literature Demo

Current task
#14238

Contribution Today
--------------------------------
Tasks              238
Tokens             318,481
API cost           $0.14

Resources
--------------------------------
Ollama              Enabled
Commercial API      Disabled

Daily API limit     $0.25
Monthly API limit   $5.00

[ Pause Contributions ]
```

---

# 36. Worker Settings

Sections:

## Coordinator

- coordinator URL
- connection status
- worker ID

## Providers

- Ollama
- commercial provider
- model selection

## Limits

- daily API cost
- monthly API cost
- CPU limit
- GPU preference

## Schedule

- always
- only while idle
- custom schedule

## Projects

Allow:

```text
All approved projects
```

or:

```text
Selected categories
```

Potential categories:

- science
- medicine
- astronomy
- climate
- open source
- history
- education

---

# 37. Dashboard

The coordinator web dashboard should initially show:

## Network

```text
Connected workers
Active workers
Tasks waiting
Tasks processing
Tasks completed
```

## Compute

```text
Tokens processed
Local inference hours
API compute donated
```

## Projects

```text
Project
Progress
Tasks complete
Workers
```

## Workers

```text
Worker
Status
Tasks
Provider
Last seen
```

---

# 38. Public Project Page

Each project should eventually have a public page.

Example:

```text
Open Literature Classification

Goal
Classify 1,000,000 scientific abstracts.

Progress

██████████████░░░░░ 73%

731,482 / 1,000,000

Contributors
4,218

AI Compute Donated
$4,381 equivalent
```

This is important psychologically.

People should be able to see what their donated compute accomplished.

SETI@home understood this long before engagement dashboards became a corporate religion.

---

# 39. Project SDK

Projects should be definable without modifying coordinator code.

Example:

```typescript
export default defineProject({

  id: "abstract-classification",

  inputSchema,

  outputSchema,

  buildPrompt(task) {
    return {
      system: SYSTEM_PROMPT,
      user: task.abstract
    };
  },

  validate(result) {
    return result.confidence >= 0 &&
           result.confidence <= 1;
  }

});
```

---

# 40. Project Manifest

Alternative declarative configuration:

```yaml
id: abstract-classification

name: Scientific Abstract Classification

version: 1.0.0

capability:
  type: text_generation

requirements:
  minimum_context: 8192

validation:
  mode: consensus
  replicas: 2
```

The SDK can combine declarative metadata with executable validation logic.

---

# 41. Security Model

Treat every component as potentially untrusted.

Assume:

- workers may be malicious
- coordinators may send malformed tasks
- project definitions may be malicious
- AI providers may fail
- returned results may be fraudulent
- network traffic may be intercepted
- API credentials are highly sensitive

---

# 42. Do Not Execute Arbitrary Code

MVP project tasks must be **data + AI requests**, not arbitrary executables.

Allowed:

```text
Send this text to an AI model.
Return JSON matching this schema.
```

Not allowed:

```text
Download this binary and run it.
```

This greatly reduces the attack surface.

---

# 43. Task Size Limits

Coordinator must enforce maximum:

- payload size
- context length
- output tokens
- task runtime

The worker should enforce local equivalents.

Example MVP limits:

```text
Payload:        1 MB

Runtime:        10 minutes

Output:         32 KB
```

---

# 44. Prompt Safety

The project system prompt must be visible to volunteers.

Workers should be able to inspect:

- project description
- prompt template
- expected output schema
- requested model
- maximum token usage

No hidden arbitrary instructions should execute locally.

---

# 45. Logging

Use structured logs.

Recommended:

```text
Pino
```

Log:

- task ID
- worker ID
- provider
- model
- runtime
- success/failure
- retry count

Never log:

- API keys
- authentication tokens
- secrets

Avoid logging complete task contents by default.

---

# 46. Observability

Expose coordinator health metrics.

Eventually:

- Prometheus
- OpenTelemetry

MVP metrics:

```text
worker_count

active_worker_count

task_queue_depth

task_completion_rate

task_failure_rate

average_task_duration
```

---

# 47. Retry Behavior

Worker retry policy:

```text
Attempt 1
   |
   fail
   |
5 second delay
   |
Attempt 2
   |
   fail
   |
30 second delay
   |
Attempt 3
```

After final failure:

```text
POST /tasks/:id/fail
```

Coordinator returns task to queue where appropriate.

---

# 48. Rate Limiting

Coordinator should rate limit:

- registration
- task requests
- result submissions
- heartbeat endpoints

Use reasonable IP and worker-level limits.

---

# 49. Authentication

MVP worker authentication:

```text
worker token
```

Registration returns:

```text
worker_id
worker_secret
```

Worker signs requests using bearer authentication.

Later:

- rotated credentials
- signed messages
- public/private worker keys

---

# 50. Result Integrity

Results should eventually include hashes.

Example:

```text
SHA-256(
  task_id +
  result_json +
  worker_id
)
```

The MVP may store this directly.

Cryptographic worker signatures can follow later.

---

# 51. Duplicate Work Protection

Results should be idempotent.

Use:

```text
task_id + worker_id
```

as an idempotency key.

Repeated submission should not create duplicate contribution credit.

---

# 52. Privacy

Public statistics should not expose:

- IP addresses
- API providers unless volunteer allows it
- API keys
- local machine names
- usernames
- email addresses
- geographic location

Workers should use randomized public IDs.

Example:

```text
worker_f4e82
```

---

# 53. Local Privacy

Commercial API providers receive whatever project input is sent through them.

This must be disclosed to volunteers.

Projects involving sensitive data should be capable of specifying:

```text
local_models_only: true
```

---

# 54. Licensing

Recommended initial license:

```text
Apache License 2.0
```

Reasons:

- permissive
- contributor friendly
- patent provisions
- suitable for infrastructure projects
- commercial use allowed

MIT is also acceptable but provides fewer explicit patent protections.

---

# 55. GitHub Repository Requirements

Create:

```text
README.md

LICENSE

CONTRIBUTING.md

SECURITY.md

CODE_OF_CONDUCT.md

AGENTS.md
```

Use GitHub Issues for:

- bugs
- features
- provider requests
- project proposals

Use GitHub Discussions for:

- architecture
- research ideas
- general community discussion

---

# 56. README Structure

The public README should clearly answer:

1. What is AI Commons?
2. Why does it exist?
3. What can I contribute?
4. How does it work?
5. Does AI Commons receive my API keys?
6. Can it spend unlimited money?
7. What projects are available?
8. How do I run a worker?
9. How do I create a project?
10. How do I contribute code?

---

# 57. Example README Opening

```markdown
# AI Commons

AI Commons is an open-source distributed AI computing network.

It allows volunteers to contribute local AI inference, idle GPU resources,
or limited AI API usage toward large public-good workloads.

Think Folding@home, but for AI inference.

Your API credentials remain on your machine.
You control exactly how much compute or API budget may be contributed.
```

---

# 58. MVP Development Phases

## Phase 1: Protocol

Build:

- shared types
- project definition schema
- task schema
- result schema
- worker capability schema

Success condition:

Schemas compile and can round-trip between worker and coordinator.

---

## Phase 2: Coordinator

Build:

- Fastify server
- PostgreSQL
- projects
- workers
- task queue
- leasing
- results

Success condition:

A test client can register, lease a task, and submit a result.

---

## Phase 3: CLI Worker

Before building a GUI, create a CLI worker.

Commands:

```text
aicommons configure

aicommons status

aicommons start

aicommons pause
```

Success condition:

CLI worker completes distributed tasks using Ollama.

---

## Phase 4: Ollama Adapter

Support:

- connectivity
- model enumeration
- task execution
- JSON output
- usage metrics

Success condition:

Two independent machines can process project tasks.

---

## Phase 5: Validation

Implement:

- JSON Schema validation
- duplicate execution
- consensus validation

Success condition:

Coordinator can reject invalid results and accept consensus results.

---

## Phase 6: Commercial Provider

Implement one remote provider.

Requirements:

- locally stored credential
- token usage
- cost accounting
- local spending limits

Success condition:

Worker cannot exceed the configured spending ceiling.

---

## Phase 7: Dashboard

Build basic web dashboard.

Show:

- workers
- queue
- project progress
- contribution totals

Success condition:

Project progress can be observed in real time.

---

## Phase 8: Desktop Worker

Convert CLI worker into a user-friendly application.

Potential frameworks:

- Tauri
- Electron

Preferred:

```text
Tauri
```

Reasons:

- small binaries
- lower memory overhead
- Rust security boundary
- modern UI support

---

# 59. MVP Acceptance Test

The MVP is considered successful when:

```text
10 independent worker machines

process

10,000 tasks

using

at least 2 AI providers

with

task leasing
validation
budget enforcement
contribution accounting

and

no API credentials pass through the coordinator.
```

---

# 60. Recommended First Demonstration

Create:

```text
AI Commons Demo Project
```

Dataset:

```text
10,000 public scientific abstracts
```

Goal:

Classify each abstract into:

```text
primary discipline
secondary topics
study type
```

Run across:

```text
Ollama workers

+

one commercial API provider
```

Display live progress publicly.

---

# 61. Future Architecture

After the MVP works reliably, consider:

## Provider Expansion

- Anthropic
- Gemini
- OpenRouter
- llama.cpp
- vLLM
- LM Studio
- custom OpenAI-compatible providers

---

## Advanced Scheduling

Route workloads based on:

```text
cost

model capability

hardware

privacy requirements

context window

latency

volunteer preference
```

---

## Research Institution Accounts

Universities and nonprofits could submit approved workloads.

---

## Public Project Directory

Users browse projects and choose which ones they want to support.

---

## Reputation

Worker reputation may incorporate:

- successful validations
- reference-task accuracy
- uptime
- task completion
- failure rate

---

## Federation

Multiple independent coordinators could eventually share a common protocol.

Do not implement federation until the central model is mature.

---

# 62. Potential Hosted Business Model

The open-source project may eventually support a commercial service operated by Tartalon.

Possible hosted services:

```text
managed coordinator

managed databases

project hosting

private organizations

research dashboards

priority queues

advanced analytics

private deployments

enterprise support
```

Core volunteer infrastructure should remain open.

---

# 63. Important Product Boundary

AI Commons should not initially become an AI API resale service.

The platform coordinates donated resources.

This distinction simplifies:

- architecture
- billing
- trust
- provider integrations
- regulatory concerns

---

# 64. Long-Term Vision

The long-term goal is a global pool of voluntarily contributed AI computation.

Participants could contribute:

```text
$1/month API budget

or

idle local GPU time

or

local CPU inference

or

institutional AI capacity
```

Projects could consume that distributed capacity for:

- scientific analysis
- medical research
- astronomy
- climate modeling
- open-source software
- public datasets
- archival analysis
- education
- humanitarian research

Conceptually:

```text
                    AI COMMONS

    Millions of independent AI resources

                         |

                         v

              Shared Compute Network

                         |

          +--------------+--------------+
          |              |              |
          v              v              v

       Science       Open Source      Research
```

---

# 65. Design Philosophy

Keep the platform boring where possible.

Distributed systems are already complicated enough without adding ceremonial architecture.

Prefer:

```text
HTTP

JSON

PostgreSQL

SQLite

simple queues

typed schemas

well-defined adapters
```

over:

```text
microservice swarms

blockchains

custom consensus algorithms

distributed event fabrics

twenty databases

architecture diagrams requiring cartography training
```

Earn complexity only when scale proves it is necessary.

---

# 66. Agent Development Rules

Agents working on this repository should follow these rules.

## Before Implementation

Read:

```text
README.md

AGENTS.md

docs/architecture.md

docs/security.md

docs/protocol.md
```

---

## Engineering Requirements

Agents must:

- preserve strict TypeScript typing
- avoid `any`
- validate network inputs
- add tests for new behavior
- use project-wide abstractions
- keep provider-specific code isolated
- never log credentials
- never transmit provider API keys
- preserve local budget enforcement
- avoid unnecessary dependencies
- document architectural changes

---

## Change Discipline

Do not combine unrelated refactors with feature work.

Each implementation should:

1. identify the relevant subsystem
2. inspect existing architecture
3. implement the smallest coherent change
4. add tests
5. run formatting
6. run linting
7. run type checking
8. run tests
9. update documentation where required

---

# 67. Definition of Done

A feature is not complete until:

- implementation exists
- tests pass
- input validation exists
- errors are handled
- security implications are considered
- documentation is updated
- no secrets are exposed
- no user spending limit can be bypassed

---

# 68. First Engineering Tasks

Implement in this order:

```text
1. Create monorepo.

2. Create shared protocol package.

3. Define Project schema.

4. Define Task schema.

5. Define Result schema.

6. Create PostgreSQL schema.

7. Build worker registration endpoint.

8. Build task ingestion endpoint.

9. Build task leasing endpoint.

10. Build result submission endpoint.

11. Build CLI worker.

12. Implement Ollama adapter.

13. Create abstract-classification demo.

14. Run two workers simultaneously.

15. Add result validation.

16. Add contribution metrics.

17. Add commercial provider adapter.

18. Add local budget limiter.

19. Build dashboard.

20. Package Windows worker.
```

Do not skip directly to the desktop UI.

The CLI should prove the system first.

---

# 69. MVP Success Question

Every architecture decision should ultimately answer this question:

> Can many independent volunteers safely contribute AI inference toward one useful workload without surrendering their credentials or control over their resources?

If the answer is yes, the concept has been validated.

Everything after that is scale, usability, and ecosystem building.