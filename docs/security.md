# Security

AI Commons treats every component as potentially untrusted (spec §41). This
document covers the worker; coordinator notes belong here as they are added.

## Credentials

- Provider API keys and the coordinator-issued `worker_secret` are stored only
  in the OS credential store via `@napi-rs/keyring`: Windows Credential Manager,
  macOS Keychain, or Linux Secret Service.
- There is **no plaintext fallback**. If the credential store is unavailable the
  worker refuses to continue (`SecretStoreUnavailableError`).
- Keys are read from a hidden prompt or stdin, never from argv.
- API keys are passed only to the provider adapter and never sent to the
  coordinator. Request schemas reject unknown fields, so a stray `api_key` field
  would be rejected rather than stored.
- Secrets never appear in the config file, the SQLite database, logs, or failure
  messages. Tests assert this by scanning all four for a known key.

## Logging

Pino with `redact` for authorization headers, key/secret/token fields,
`payload`, and `prompt`. Code does not log task payloads or prompt text.
Free-text error messages pass through `scrubSecrets()`, which masks known
secrets plus `sk-…`, `Bearer …`, and `key=…` patterns, before they are logged or
sent to the coordinator.

## Untrusted coordinator and projects

- Coordinator URL must be `https://`, except for `localhost`. Credentials in
  the URL are rejected, and redirects are refused.
- Every coordinator response is validated against its protocol schema, and
  bodies over ~1.25 MB are refused.
- Projects are data only. The worker renders a declarative prompt template and
  never executes project-supplied code.
- Project JSON Schemas are checked before use: no `$ref`/`$id`, known keywords
  only, bounded nesting. They are then interpreted, never compiled to code.
- Payload size (1 MB), output size (32 KB), output tokens, and runtime
  (10 minutes) are enforced locally, independent of the coordinator.

## Spending and privacy

- Spending limits are enforced locally (see `docs/worker.md`); the coordinator
  is never trusted with them.
- Remote providers receive the full task input. The worker discloses this, uses
  remote providers only for projects the volunteer explicitly allows, and never
  for `local_models_only` tasks.
