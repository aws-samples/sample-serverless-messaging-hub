# Changelog

All notable changes relative to the upstream sample this project started from.

**Baseline:** [`aws-samples/sample-serverless-messaging-hub`](https://github.com/aws-samples/sample-serverless-messaging-hub)
at commit `9942f22` (2025-04-16, *"Merge pull request #9 from aws-samples/feat/dynamo-items"*).

Scale of the change: **60 → 74 files**, **1 469 → 3 788 lines of TypeScript**, 0 → 74 automated
tests, 0 → 6 design documents.

> ### Licence
> The upstream repository is licensed **MIT No Attribution (MIT-0)**. `LICENSE`,
> `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` had gone missing from this working copy and have
> been **restored byte-for-byte** from upstream — this project remains a derivative of an AWS
> sample and carries its licence.
>
> `CONTRIBUTING.md` still describes AWS's contribution process (their issue tracker, their
> security reporting page). Adjust it if this becomes an independently maintained repository;
> leave `LICENSE` as is.

---

## Added

### Reliability
- **Dead Letter Queue per channel** with `maxReceiveCount: 3`. Upstream created the processing
  queues with no redrive policy at all, so a poison message was retried until SQS retention
  expired and then vanished silently.
- **Idempotency / exactly-once delivery.** New `idempotencyKey` field (required), a dedicated
  DynamoDB table, and AWS Lambda Powertools Idempotency with `INPROGRESS → COMPLETED`
  semantics and a per-template TTL (`idempotencyTtlSeconds`, default 1 day).
- **Multi-region, opt-in via `secondaryRegion`.** EventBridge Global Endpoint with event
  replication, DynamoDB Global Tables, a CloudWatch latency alarm driving a Route 53 health
  check for failover, and a secondary consumer plane that imports the table replicas by name.

### Observability
- **8 CloudWatch alarms per region** (DLQ depth, Lambda errors, Lambda throttles, queue age)
  wired to an SNS topic with an email subscription, notifying on both `ALARM` and `OK`.
  Upstream had no alarms and no alarm topic.
- **X-Ray active tracing** (`Tracing.ACTIVE`). Upstream set `POWERTOOLS_TRACE_ENABLED: "true"`
  and instrumented the handlers with the Powertools `Tracer`, but never enabled tracing at the
  Lambda service level — so no segment was ever emitted and the instrumentation was inert.
- **Managed log group per function** with 3-month retention, created by CloudFormation so the
  group is torn down with the stack.

### Audit and non-repudiation
- **Two-stream audit trail**: synchronous acceptance (`providerMessageId`, recipient hashed
  SHA-256) converted natively to **Parquet** by Firehose, plus asynchronous SES delivery
  events (`send`, `delivery`, `bounce`, `complaint`, `reject`) kept as raw JSON.
- **Glue catalog + Athena**, partitioned by date with partition projection. The two streams
  join on the `idempotencyKey` SES message tag to produce an acceptance-to-outcome report.
- **Two saved Athena queries** shipped with the stack (`-delivery-outcome`,
  `-delivery-problems`) so delivery visibility needs no SQL. The second one also catches
  silently spam-quarantined messages, which report `250 OK` and would otherwise look like
  successes.
- **Optional S3 Object Lock (WORM)** with configurable mode, retention window, archive tier
  and expiry.

### Testing
- **74 automated tests** where upstream had none: 41 CDK infrastructure assertions and 33
  Lambda unit tests, on Vitest.

### Documentation
- Six documents under `docs/`: producer integration guide (with runnable Python and
  TypeScript examples), user story, idempotency/audit design, compliance control inventory,
  cost review, and live end-to-end evidence. The README grew from 187 to 750 lines.

---

## Changed

### Portability — the largest structural change
- **Resource naming moved out of code.** Upstream hardcoded `APP_ORGANIZATION: 'aws'` and
  `APP_NAME: 'serverless'` in `lib/utils/constants.ts`, so every deployment was named
  `aws-<env>-serverless-*`. Both now come from `organization` / `appName` in the environment
  YAML; changing two values renames every queue, table, bucket, bus, rule and function.
- **Tag values** (`Product`, `Owner`) moved from code constants to YAML.
- **Multi-environment config.** One root-level `env-sandbox.yml` became `env/env-{dev,qa,prod}.yml`.
- **SSM account path derived** as `/${appName}/${environment}/account` instead of being written
  out by hand.
- **Config now governs behaviour, not just names**: log retention, log level, event logging,
  tracing, all alarm thresholds and periods, the failover trigger, and the full audit
  retention lifecycle are YAML values. Nothing about them is hardcoded.
- **YAML path resolved against the repo root** rather than the working directory, so `cdk`
  works from any directory.

### Security
- **SQS encryption and TLS.** All four queues now use SSE-SQS with `enforceSSL: true`.
  Upstream created queues with neither, despite message bodies carrying email addresses,
  phone numbers and names.
- **SES scoped by ARN.** `ses:SendEmail` / `ses:SendRawEmail` moved from `Resource: "*"` to the
  `identity/*` and `configuration-set/*` ARNs of the deploying account and region.
- **Audit bucket** adds `enforceSSL`, explicit SSE-S3 and `BLOCK_ALL`.
- **Recipient hashed** (SHA-256) in the acceptance audit record rather than stored in clear
  text.

### Data layer
- **`Table` → `TableV2`**, which is what makes Global Tables possible.
- **Retention became a config axis.** Upstream hardcoded `deletionProtection: true` and
  `RemovalPolicy.RETAIN` on the templates table, so even a sandbox teardown left the table
  behind. Now driven by `retainData`: RETAIN in qa/prod, DESTROY in dev.
- Stream changed from `NEW_IMAGE` to `NEW_AND_OLD_IMAGES`.
- Second table added for idempotency, with TTL on `expiration`.

### Runtime and messaging
- **Node.js 20 → 22**, and **x86_64 → arm64** (upstream never set `architecture`, so it
  defaulted to x86_64).
- **SMS is now `Transactional`, not `Promotional`.** Upstream sent every SMS with
  `AWS.SNS.SMS.SMSType: "Promotional"`, which is deprioritised by carriers and wrong for
  one-time codes and operational alerts.
- **SMS Sender ID is optional configuration.** Upstream hardcoded it to the `product` value,
  which both leaked the product name into the wire format and fails in regions where Sender ID
  is unsupported (US/Canada). It is now omitted unless `sms.senderId` is set.
- **Email templates located via the `templatePath` attribute** in DynamoDB, replacing a
  derived naming convention — one source of truth for where a template lives.
- **Timeouts raised from 10s to 30s** for both Lambdas and the queue visibility timeout, and
  the visibility timeout is now deliberately aligned with the Lambda timeout.

### Structure
- Lambda `layer/commons/` folded into `src/common/`, removing `../../../layer/...` relative
  imports and the unused layer packaging.
- Nested stacks went from 4 to 6 (Audit and Monitoring added); IDs normalised
  (`DatabasesNestedStackConstruct` → `DatabaseNestedStackConstruct`,
  `BusesNestedStackConstruct` → `EventsNestedStackConstruct`).
- Demo templates renamed from `productA/welcomeMessage.html` to `demo/welcome.html`.
- Test runner changed from Jest to **Vitest**.

---

## Fixed

Bugs found in the baseline while working through it.

- **Duplicate-email race in `SendEmailService`.** Upstream called
  `sqsUtil.deleteMessage(receiptHandle, urlSQS)` by hand after sending, then rethrew on any
  error. With an SQS event source mapping Lambda already deletes the message on success, so
  this was redundant — and if the delete failed *after* SES had accepted the email, the rethrow
  caused SQS to redeliver and **the email was sent twice**. The manual delete and the
  `URL_SQS_RECEIPT_EMAIL` / `URL_SQS_RECEIPT_SMS` environment variables are gone.
- **`ses:SendEmail` leaked into the S3 policy statement.** Upstream's `fullS3GetObject`
  statement declared `actions: ["s3:GetObject", "ses:SendEmail"]` on `"*"` and attached it to
  *both* functions, so the SMS Lambda could send email. Statements are now separated and
  scoped.
- **Floating promise in the CDK entry point.** The stack was constructed inside a `.then()`
  and failures were only `console.error`'d, so a missing SSM parameter produced a
  zero-exit-code run that silently synthesized nothing. Replaced with `async main()` and a
  non-zero exit on failure.
- **`terminationProtection` was silently ignored**, having been placed inside the `env` object
  where it is not a valid property.
- **S3 destroy would fail.** The templates bucket combined `RemovalPolicy.DESTROY` with
  `versioned: true` and no `autoDeleteObjects`, so `cdk destroy` failed once any object
  existed. `autoDeleteObjects` added.
- **Email addresses were never validated.** The Zod schema used `mail: z.string()` while the
  TypeScript type declared `string | string[]` — so invalid addresses passed validation and
  arrays failed at runtime despite being documented. Now validated as an email or a list of
  emails.
- **Test suite could not run.** `jest.config.js` pointed `roots` at `<rootDir>/test`, a
  directory that did not exist, and `aws-sdk-client-mock` sat in devDependencies unused.
- **`bin/cdk_test.ts` could not build.** It imported `cdk-nag`, which was absent from
  `package.json`, and passed `environmentVariables.account` (the SSM *path*, e.g.
  `/sandbox/account`) as the AWS account ID. File removed; `cdk-nag` remains a reasonable
  future addition, as a proper dependency.
- **Powertools declared as devDependencies** despite being runtime imports. Moved to
  `dependencies`.
- **Copy-paste identifiers** from an unrelated project cleaned up: the DynamoDB table
  construct was `EnrollmentProcess` and the SMS rule construct was `OnboardingTermsCond`.
- **S3 bucket names lacked a region suffix**, which would have collided on the second region
  once multi-region was introduced (S3 names are globally unique).

---

## Removed

- `bin/cdk_test.ts` — did not compile (see above).
- `src/aws-lambdas/layer/` — folded into `src/common/`.
- `@aws-sdk/client-secrets-manager` and `@aws-sdk/client-sqs` — no longer used once the manual
  SQS delete was removed.
- `jest`, `ts-jest`, `@types/jest`, `jest.config.js` — replaced by Vitest.
- `lib/utils/images/` — the directory was already empty in this working copy; the original
  architecture diagrams are still in the upstream repository if you want to restore them.
- `env-sandbox.yml` — superseded by `env/env-{dev,qa,prod}.yml`. The `sandbox` and `uat`
  environments were dropped from the allowed list.

---

## Known gaps

Carried forward deliberately, documented rather than hidden.

- **SMS has never been validated end-to-end.** The path is implemented and unit-tested, and
  its queue, DLQ and alarms are deployed, but no SMS template is seeded, the Lambda has never
  been invoked, and the account is in the SNS SMS sandbox with a $1 monthly spend limit.
- **Clear-text recipient inside the raw SES delivery events.** Deliberate — a non-repudiation
  record should be the unaltered provider payload — but it means the audit store holds
  unhashed PII. Mitigated by not projecting those fields in the Glue schema. See
  [`docs/compliance.md`](./docs/compliance.md).
- **No automated data-subject erasure workflow.** Deletion is a manual operator action whose
  feasibility depends on the `audit.worm` / `audit.wormMode` configuration.
- **qa and prod have never been deployed.** Their SSM account parameters do not exist, so both
  are validated by synthesis only. Object Lock is a create-time bucket property, so the first
  prod deploy is the only chance to configure it correctly.
- **Emails land in spam.** Sending from a bare email identity with no domain-aligned
  DKIM/SPF/DMARC results in `DMARC:Quarantine` or outright blocks. Verifying a sending domain
  and exiting the SES sandbox is outstanding operational work.
- **Athena's `primary` workgroup has no query result location**, so the saved queries will fail
  in the console until one is configured.
- Still on the backlog from the original design: SES bounce/complaint suppression list,
  CloudWatch dashboard, explicit X-Ray sampling rule, Parquet conversion for `ses_events`,
  cross-region replication to a central audit bucket.
