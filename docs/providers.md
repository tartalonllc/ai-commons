# Providers

Provider adapters implement `AIProvider` from `@ai-commons/provider-core` and
run only inside the worker. Provider-specific logic stays inside the adapter
package.

## Shared behavior

- **No SDKs.** Adapters use `fetch` (injectable via the `fetch` option for tests).
- **Deadlines.** Each call combines `request.timeout_ms` with the caller's
  `request.signal`. A caller abort surfaces as `cancelled`; a deadline as `timeout`.
- **No retries.** Adapters make one attempt; the worker owns the retry policy
  (spec §47) and decides using `ProviderError.retryable` and `retryAfterMs`.
- **Output.** Adapters request structured JSON using the project output schema,
  then parse it with `parseJsonObject`. Schema validation happens in the worker.
  Truncated (`length`) or refused outputs are `invalid_output`.
- **Errors.** Adapters throw only `ProviderError`, and never attach a `cause`
  that could carry request details.

| Condition                     | Code              | Retryable |
| ----------------------------- | ----------------- | --------- |
| Connection failure            | `unavailable`     | yes       |
| Deadline exceeded             | `timeout`         | yes       |
| Caller aborted                | `cancelled`       | no        |
| HTTP 401 / 403                | `auth`            | no        |
| HTTP 404                      | `model_not_found` | no        |
| HTTP 429 (`Retry-After` read) | `rate_limited`    | yes       |
| HTTP 5xx                      | `unavailable`     | yes       |
| Other HTTP 4xx                | `bad_request`     | no        |
| Unparseable / truncated JSON  | `invalid_output`  | yes       |

## Ollama (`@ai-commons/provider-ollama`)

```ts
new OllamaProvider({
  baseUrl?: string,              // default http://localhost:11434 (http/https only)
  metadataTimeoutMs?: number,    // tags/show/version calls, default 10 s
  resolveContextWindows?: boolean, // query /api/show per model, default true
  fetch?: typeof fetch,
});
```

- `kind: 'local'`; no credential; `estimateCost` always returns `max_usd: 0`.
- `execute` calls `POST /api/chat` with `stream: false`, `format: <output_schema>`,
  `options.num_predict = max_output_tokens`, and `think: false`. If a model rejects
  the `think` field, the adapter resends once without it and remembers that model.
  A leading `<think>…</think>` block is stripped before parsing.
- Token metrics come from `prompt_eval_count` / `eval_count`.
- `healthCheck` calls `/api/version`.

## OpenAI (`@ai-commons/provider-openai`)

```ts
new OpenAIProvider({
  apiKey: string,                // from the OS credential store — never env/files
  pricing: Record<model, { input_per_mtok: number; output_per_mtok: number }>,
  baseUrl?: string,              // default https://api.openai.com/v1
  id?: string,                   // default 'openai'; set for compatible endpoints
  inputSafetyFactor?: number,    // default 1.5, must be >= 1
  metadataTimeoutMs?: number,    // default 15 s
  fetch?: typeof fetch,
});
```

- `kind: 'remote'`. Uses Chat Completions with
  `response_format: { type: 'json_schema', json_schema: { name: 'result', schema, strict: false } }`
  and `max_completion_tokens`.
- **Only priced models run.** `estimateCost` and `execute` throw `bad_request`
  for a model missing from `pricing`, so the worker can never spend on a model
  whose cost it cannot bound (spec §20).
- `estimateCost.max_usd` prices `ceil(estimated_input × inputSafetyFactor)` input
  tokens plus the full `max_output_tokens`. The input estimate includes the
  output schema, which is sent with the request.
- Actual `cost_usd` comes from response `usage`. If usage is missing, the adapter
  reports the pre-request upper bound so local accounting never undercounts.
- `getModels` returns priced models, intersected with `GET /models` when the
  endpoint implements it.
- **Credential handling.** The key is held in a `#private` field and appears only
  in the `Authorization` header. Error messages surface only OpenAI's structured
  error `code`/`type`, never its free-text message (which can echo a masked key).
  Plain `http://` base URLs are rejected except for loopback hosts, so keys are
  never sent in cleartext over a network.

Pricing is supplied by the worker configuration rather than shipped as defaults,
because provider prices change and a stale built-in table would silently
under-budget.
