# Example: Scientific Abstract Classification

The AI Commons demo workload (spec §5, §60). Each task is one public arXiv
abstract. Workers classify it into:

| Field                 | Type                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| `primary_discipline`  | one of 13 disciplines (`physics`, `biology`, `computer_science`, …)                |
| `secondary_topics`    | 1–5 short topic phrases                                                            |
| `study_type`          | `experimental`, `observational`, `computational`, `theoretical`, `review`, `other` |
| `contains_experiment` | boolean                                                                            |
| `confidence`          | 0–1                                                                                |

Validation uses consensus: two workers classify each abstract, and they must
agree on `primary_discipline` and `study_type`. If they disagree, a third
worker breaks the tie.

The full definition, including the system prompt volunteers can inspect, is in
[`project.ts`](./project.ts).

## Data

arXiv metadata, including abstracts, is released under CC0.
`data/sample.jsonl` holds 20 real abstracts across several categories, fetched
with the script below.

Fetch a larger dataset (defaults to 10,000). The script paces requests 3 s
apart, per arXiv's API guidelines. It resumes from an existing JSONL file, skips duplicate IDs, and honors `Retry-After` when the API rate-limits a request:

```sh
pnpm build   # from the repo root, once
cd examples/abstract-classification
node scripts/fetch-arxiv.ts --count 10000 --out data/abstracts.jsonl
```

Records are `{ "id": "arxiv_2409_01234v1", "title": "…", "abstract": "…" }`.

## Publish to a coordinator

```sh
COORDINATOR_URL=http://localhost:3000 ADMIN_TOKEN=... \
  node scripts/publish.ts data/abstracts.jsonl
```

The script creates the project, or continues if it already exists. It then
ingests tasks in batches of 250 to stay under the coordinator request-size limit, skipping and reporting any record that fails
the input schema. Scripts run on Node ≥ 22.18 using native TypeScript type
stripping, so no build step or `tsx` is needed.

## Privacy note

Commercial providers receive the text of each abstract they process. The data
here is public, so `local_models_only` is `false`.
