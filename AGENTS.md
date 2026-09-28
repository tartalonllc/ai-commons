# Agent Guidelines

Before implementing anything, read `README.md`, this file, and the relevant
docs in `docs/` (`protocol.md` first). The full specification lives in
`Open Compute.md`. Current status is in `PROGRESS.md`; resume from `NEXT_STEPS.md`.

## Engineering requirements

- Strict TypeScript; no `any` (enforced by ESLint).
- Validate every network input against a `@ai-commons/protocol` schema.
- Add tests for new behavior.
- Keep provider-specific code inside its adapter package.
- Never log, persist in plaintext, or transmit provider API keys or worker secrets.
- Worker spending/resource limits are enforced locally; never rely on the coordinator.
- Tasks are data + AI requests only. Never execute code supplied by a project or coordinator.
- Avoid unnecessary dependencies; document architectural changes in `docs/`.

## Change discipline

Do not mix unrelated refactors with feature work. For each change:

1. Identify the subsystem and inspect its existing architecture.
2. Implement the smallest coherent change, with tests.
3. Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
4. Update documentation where required.
