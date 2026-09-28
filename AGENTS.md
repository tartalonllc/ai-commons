# Agent Guidelines

Before implementing anything, read `README.md`, this file, and the relevant
docs in `docs/` (`protocol.md` first). The full specification lives in
`Open Compute.md`.

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

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
