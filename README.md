# AI Commons

AI Commons is an open-source distributed AI computing network.

It allows volunteers to contribute local AI inference, idle GPU resources,
or limited AI API usage toward large public-good workloads.

Think Folding@home, but for AI inference.

Your API credentials remain on your machine.
You control exactly how much compute or API budget may be contributed.

> **Status:** early MVP development. Phase 1 (protocol) is in place; the
> coordinator, CLI worker, and providers are next. See
> [`Open Compute.md`](./Open%20Compute.md) for the full build specification.

## Repository layout

| Path                   | Purpose                                               |
| ---------------------- | ----------------------------------------------------- |
| `packages/protocol`    | Shared wire schemas and types (TypeBox/JSON Schema)   |
| `apps/coordinator`     | Fastify + PostgreSQL task coordinator _(planned)_     |
| `apps/worker`          | CLI volunteer worker _(planned)_                      |
| `apps/dashboard`       | Live web dashboard (see docs/dashboard.md)            |
| `packages/providers/*` | Provider adapters: Ollama, one commercial _(planned)_ |
| `examples/*`           | Example workloads _(planned)_                         |

## Development

Requires Node.js ≥ 22.12 and pnpm 10.

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
