# scripts/

Dev and ops scripts for AirmailAI. All run with `bun scripts/<name>.ts` from
the repo root; Bun auto-loads `.env` (see `.env.example`).

| Script                          | Purpose                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `update-model-list.ts`          | Rebuild `models.json` from the provider APIs and docs. `bun run models:update`                         |
| `model-watcher.ts`              | Report provider model ids not yet acknowledged by a successful update. `bun run models:watch`         |
| `deploy-model-list.ts`          | Deploy the watcher/updater Lambdas and their infra. `bun run deploy:model-list`                        |
| `deploy-web.ts`                 | Build and deploy the website to S3 + CloudFront. `bun run deploy:web`                                  |
| `asset-retention.ts`            | Library used by `deploy-web.ts` to prune hashed assets unused for seven days                           |
| `gen-version.ts`                | Write `VERSION` / `VERSION_NAME` from the git state (runs at the start of every build)                 |
| `gen-third-party-licenses.ts`   | Regenerate the third-party license notices from runtime dependencies                                   |
| `gen-logo.ts`, `gen-graphics.ts` | Render the stamp logo and store/promo graphics into `packages/airmailai_web/static/`                  |
| `provider-test.ts`              | Isolation harness for the extension's provider streams and server tools                                |
| `model-list/`                   | Library shared by the model list scripts and the Lambda handlers (see below)                           |

## The model list

The website does not compile its model list in. It fetches `/models.json` at
boot, validates it, and builds the provider pickers from it. That file is the
single output of everything in `model-list/`.

### Where things live

| What                          | Local                                            | AWS                                             |
| ----------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| Published model list          | `packages/airmailai_web/static/models.json`      | `s3://<www-bucket>/models.json` (via CloudFront) |
| Docs cache, probe cache       | `scripts/.tmp/{docs,probe}-cache.json`           | `s3://<state-bucket>/{docs,probe}-cache.json`    |
| Watcher state                 | `scripts/.tmp/watcher-state.json`                | `s3://<state-bucket>/watcher-state.json`         |
| Run snapshots (debug)         | `scripts/.tmp/snapshots/`                        | `s3://<state-bucket>/snapshots/` (30-day expiry) |
| Tier assignments              | `packages/airmailai_web/src/lib/models/tiers.ts` | shipped inside the site bundle                   |
| Per-model overrides           | `scripts/model-list/overrides.ts`                | bundled into the Lambda                          |

The S3 copy of `models.json` is production truth. The repo copy is what
`vite dev`, the e2e tests, and the harness scripts read, and it is committed so
a fresh clone works offline. `deploy-web.ts` never uploads it; only the updater
does.

### Storage mode

Mode is picked from `.env`, and the same code runs in both:

- `AIRMAILAI_WEB_AWS_PROFILE` **unset** (or `--local` passed): caches, state,
  and `models.json` all stay on disk. Only the provider API keys are needed.
- `AIRMAILAI_WEB_AWS_PROFILE` **set**: caches and state come from the state
  bucket, the S3 copy of `models.json` is merged in as a base, and `--write`
  publishes to S3 (with a CloudFront invalidation) as well as the repo copy.
  Needs `AIRMAILAI_WEB_S3_BUCKET`, `AIRMAILAI_WEB_CLOUDFRONT_DISTRIBUTION_ID`,
  and `AIRMAILAI_MODEL_LIST_STATE_BUCKET`.
- Inside Lambda: S3 only. Secrets load from SSM Parameter Store at cold start.

If `AIRMAILAI_DISCORD_WEBHOOK_URL` is set, publishes and watcher detections or
errors post reports to Discord; otherwise reports are console-only. Messages
are split at both ten embeds and 6,000 combined title/description characters.
Notification failures are surfaced as errors. The watcher hands work to the
updater before attempting its notification.

### How an update works

1. Load both caches and every reachable copy of `models.json`. The copies are
   unioned into the base (S3 wins on overlap).
2. For each requested provider, run its pipeline: list models from the API,
   fill gaps from OpenRouter metadata and the provider's docs pages (cached),
   apply `overrides.ts`, and probe each model once with a one-token request
   (cached, 30-day TTL on non-200s).
3. Merge per provider: fresh models replace matching ids, models the provider
   no longer lists are **kept verbatim** and reported as "unlisted". Models are
   removed only when explicitly listed in `RETIRED_MODEL_IDS` in `overrides.ts`.
   If a provider's pipeline throws (API down, bad
   key, 0 models derived), that provider's section is carried over untouched
   and the failure is reported.
4. Apply the retirement lists to every provider, including providers not
   requested in this run, and report those removals separately from unlisted
   models. Validate the whole document.
5. Publish to S3 first in AWS mode, then update the repo copy. Each publication
   reloads the current target and merges in the successful pipeline results.
   S3 writes use the current ETag (`If-Match`), or `If-None-Match: *` for a
   missing object. A concurrent write causes a fresh read and merge before
   retrying, so overlapping manual and Lambda runs preserve each other's
   additions. Local updates use exclusive locks under `scripts/.tmp/locks/`.
6. Write each target only if its model content differs. `generatedAt` only
   advances when a model list changes. Provider failures are reported and make
   the command or Lambda fail after successful providers have been published.

Dry run is the default; nothing writes to `models.json` without `--write`.
Caches and snapshots are updated on every run.

```
bun run models:update                         dry run, all providers
bun run models:update --write                 publish
bun run models:update --write --openai        one provider only
bun run models:update --verbose               print every derived model
bun run models:update --refresh-docs          ignore the docs cache
bun run models:update --refresh-probes        ignore the probe cache
bun run models:update --retry-non-200         retry cached failures early
bun run models:update --local                 force disk mode
```

Debug helpers (no writes):

```
bun run models:update --model-test <anthropic|openai|google> <model-id>
bun run models:update --scrape-test <openai-model-id> [--show-md]
bun run models:update --google-scrape-test <google-model-id> [--show-md]
bun run models:update --anthropic-scrape-test <docs-slug> [--show-md]
```

### The watcher

`model-watcher.ts` fetches each provider's raw model id list and diffs it against
the acknowledged ids in `watcher-state.json`. Detection alone never advances
that state. With `--update` it runs the updater for providers with unacknowledged
ids. In AWS the watcher runs hourly at :05 and invokes the updater Lambda
asynchronously, passing the observed ids along with the requested providers.

After publication completes, the updater acknowledges only the observed ids
for successful provider pipelines. Acknowledgements merge with existing state
using conditional S3 writes, so overlapping completions cannot erase each
other's acknowledgements or acknowledge ids detected by a later invocation.
Failed handoffs and failed provider updates remain detectable on the next
hourly run. Failed provider outcomes also throw from the Lambda handler to
enable Lambda's asynchronous error retries. A successful pipeline acknowledges
the raw list it processed, including non-chat models skipped by its filters.

Running `models:watch` without `--update` only reports; repeated runs continue
to report unacknowledged ids. A standalone `models:update --write` does not
acknowledge watcher state, so the next watcher run may perform a no-op update.
Dry runs never acknowledge detections. No watcher-state or models-file schema
change is required.

Local locks are released when an update finishes or throws. If a process is
terminated while holding a lock, the next update reports its path after a
five-second wait. Confirm no model-list process is running before removing
that stale lock.

Run `bun test tests/unit` for the local regression suite. The model-list tests
mock provider, AWS, and Discord requests and do not publish or spend API tokens.

### Tiers and the "New" group

Tier assignments are hand-curated in
`packages/airmailai_web/src/lib/models/tiers.ts` and ship with the site. Any
model id without an entry falls through to `new`, which shows under a "New"
group at the top of the picker for every tier setting. `latest` still wins for
the default model, so a fresh release is visible immediately but never
auto-selected.

- **Promote a model:** add its line under the provider's section (for example
  `'claude-opus-6': 'latest',`), demote what it replaces, keep the section
  alphabetized, then `bun run deploy:web`.
- **Move the e2e test model:** the `['<tier>', 'test']` tuple marks the single
  model per provider the Playwright specs use. Move the `'test'` tag; no spec
  edits needed.
- **Retire a model:** add its published model id to the provider's array in
  `RETIRED_MODEL_IDS` in `scripts/model-list/overrides.ts`, and remove its
  `tiers.ts` entry. Deploy the updated Lambdas with `bun run deploy:model-list`,
  run `bun run models:update --write` in AWS mode, then `bun run deploy:web`.
  The updater removes that id even if it remains in provider responses or a
  stale local/S3 catalog. Keep retirement entries permanently. Use published
  alias ids where the pipeline normalizes provider ids. Deploy all publishers
  with the retirement list before publishing the removal; outdated code does
  not know which models are retired. The updater reports explicit retirements
  separately and warns about OpenAI models with a published shutdown date.

### Overrides

`model-list/overrides.ts` pins what the APIs and docs cannot express: id
aliases, extra thinking levels, Anthropic tool-version pins, and thinking
levels for models missing from the docs tables. Each run warns about override
entries whose model is no longer listed.

### AWS deployment

`bun run deploy:model-list` (profile from `AIRMAILAI_WEB_AWS_PROFILE`):

1. Bundles `model-list/lambda.ts` with `Bun.build` into one ESM file and zips
   it.
2. Deploys `infra/model-list.cfn.yaml`: the private state bucket, an IAM role
   scoped to the two buckets, the distribution, and the SSM path, both
   functions (Node 22, arm64), the hourly EventBridge rule, and 30-day log
   groups.
3. Copies the four provider keys and the Discord webhook from `.env` into SSM
   as SecureString parameters under `/airmailai/model-list/`.
4. Uploads the zip to `airmailai-model-list-watcher` and
   `airmailai-model-list-updater`.

Rerun it after any code, template, or secret change. It is idempotent.

Manual invocations:

```
aws lambda invoke --function-name airmailai-model-list-watcher --profile <p> .tmp/out.json
aws lambda invoke --function-name airmailai-model-list-updater --profile <p> \
    --cli-binary-format raw-in-base64-out \
    --payload '{"providers":["openai"],"reason":"manual"}' .tmp/out.json
```

Omit `providers` to run all three. Logs are in CloudWatch under
`/aws/lambda/airmailai-model-list-*`.

## Third-party licenses

`gen-third-party-licenses.ts` generates the license notices for the runtime
dependencies actually bundled into the shipped web app and extension, writing
identical copies to `THIRD_PARTY_LICENSES` at the repo root,
`packages/airmailai_web/static/legal/third-party-licenses.txt`, and
`packages/airmailai_ext/public/third-party-licenses.txt`.

It walks the `dependencies` (not `devDependencies`) of `airmailai_web` and
`airmailai_ext`, drops the workspace package `@airmailai/shared`, reads each
installed package's license and copyright from its `package.json` and `LICENSE`
file, and emits one attribution block per package followed by the full text of
every distinct license referenced. Apache-2.0 packages that ship a `NOTICE`
file have it reproduced in their block (Apache-2.0 Section 4(d)). Packages
offered under an SPDX "X OR Y" choice get a single elected license (see
`LICENSE_ELECTIONS` in the script) so the attribution states the terms we
actually rely on.

```
bun scripts/gen-third-party-licenses.ts            dry run (prints)
bun scripts/gen-third-party-licenses.ts --write    write all three files
```

Run it with `--write` after adding or upgrading a runtime dependency.

## Provider harness

`provider-test.ts` is an isolation harness for the hand-rolled providers. It
exercises a provider's SSE to `AirmailAIChunk` mapping for a chosen server tool
(`web_search`, `web_fetch`, `code_execution`) and the stateless text-fold
replay round-trip across all tools and providers, without touching the
extension's `background.ts`. Model params and tool wire names come from the
committed `models.json`. It talks to the real provider APIs with the keys in
`.env` and costs real tokens.

```
bun scripts/provider-test.ts --provider anthropic --model claude-haiku-4-5
bun scripts/provider-test.ts --provider openai    --tool web_fetch
bun scripts/provider-test.ts --provider google    --tool code_execution --dump
```

`--dump` prints every `AirmailAIChunk` as it streams.
