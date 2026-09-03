# Messaging Hub

Serverless, **multichannel** messaging system built with AWS CDK and TypeScript.
Orchestrates email (SES) and SMS (SNS) delivery through an event-driven architecture.

It is **portable and product-agnostic**: no organization, product, or domain name is
hardcoded. Drop it into any AWS account and rebrand the whole stack by editing two
values in a YAML file.

## Architecture

```
EventBridge (central bus)
    ├── Rule "email" → SQS (+ DLQ) → Lambda SendEmail → SES
    └── Rule "sms"   → SQS (+ DLQ) → Lambda SendSMS  → SNS
                                          ↑
              DynamoDB templates (metadata: subject, source, templatePath)
              DynamoDB idempotency (dedup guard, TTL)
              S3 (HTML templates, rendered with Handlebars)

Audit: Lambda ──acceptance──→ Firehose → S3 (Parquet, Glue/Athena)
       SES config set ──delivery/bounce/complaint──→ Firehose → S3 (raw JSON)

Monitoring: CloudWatch Alarms (DLQ depth, Lambda errors/throttles, queue age)
            → SNS topic → email notification
            Logs (3-month retention) + X-Ray active tracing per function
```

**AWS services used:**

| Service | Role |
|---------|------|
| EventBridge | Central event bus — routes messages by `detail-type` (email/sms) |
| SQS | Buffer with DLQ for durability and retries (SSE-SQS encrypted) |
| Lambda | Independent processors per channel (Node.js 22, arm64) |
| SES | Email delivery with personalized HTML templates (Handlebars) |
| SNS | SMS delivery (transactional) |
| DynamoDB | Template metadata (subject, source, `templatePath`) |
| S3 | HTML template storage |

**Patterns applied:** Message Channel (SQS), Content-Based Router (EventBridge rules),
Message Translator (Lambda + Handlebars).

### Stack composition

A root stack (`ArchitectureStack`) orchestrates the **6 nested stacks** below, created in
dependency order (one deployment per region):

| # | Nested stack | Creates |
|---|--------------|---------|
| 1 | `DatabaseNestedStackConstruct` | DynamoDB tables (templates + idempotency; Global Tables in multi-region) |
| 2 | `BucketsNestedStackConstruct` | S3 bucket (HTML templates, region-scoped name) |
| 3 | `EventsNestedStackConstruct` | EventBus + rules + SQS/DLQ + the 2 Lambdas |
| 4 | `AuditNestedStackConstruct` | WORM audit bucket + Firehose + Glue + SES config set |
| 5 | `IamNestedStackConstruct` | Least-privilege policies for the Lambdas |
| 6 | `MonitoringNestedStackConstruct` | SNS alarm topic + CloudWatch alarms |

The **EventBridge Global Endpoint** is a **separate top-level stack**
(`GlobalEndpointStack`), deployed last in multi-region setups because it requires the event
bus to exist in both regions (see Multi-region below).

Cross-stack references (functions, queues, table, bucket) are wired explicitly through
constructor props, and `addDependency` enforces the ordering.

---

## Documentation

This project started from the AWS sample
[`aws-samples/sample-serverless-messaging-hub`](https://github.com/aws-samples/sample-serverless-messaging-hub).
[`CHANGELOG.md`](./CHANGELOG.md) records everything that changed since, including the baseline
bugs that were fixed and the gaps that remain open.

Design and governance docs live under [`docs/`](./docs):

| Document | Purpose |
|----------|---------|
| [`docs/producer-integration.md`](./docs/producer-integration.md) | **Start here to send messages** — Global Endpoint integration, IAM, SigV4A/CRT setup, Python + TypeScript examples, gotchas |
| [`docs/USER_STORY.md`](./docs/USER_STORY.md) | Epic and user stories — event contract, acceptance criteria (in Spanish) |
| [`docs/idempotency-and-audit.md`](./docs/idempotency-and-audit.md) | Deduplication (idempotencyKey + TTL) and audit/non-repudiation design (✅ implemented) |
| [`docs/compliance.md`](./docs/compliance.md) | Inventory of technical controls: encryption, PII handling, retention, WORM, resilience — **and the known gaps**. Not a compliance certification |
| [`docs/cost.md`](./docs/cost.md) | Architecture cost review — multi-region, 1M emails/month (estimates) |
| [`docs/e2e-evidence.md`](./docs/e2e-evidence.md) | Live end-to-end test evidence (deployed multi-region run) |

---

## Portability — make it yours

Everything product/organization specific lives in the per-environment YAML under `env/`.
There is **no branding in code**. To rebrand the entire stack, edit **two values** at the
top of `env/env-<stage>.yml`:

```yaml
organization: "acme"          # your org/company short name (resource prefix)
appName: "messaging-hub"      # this application's name
```

Every resource is named `${organization}-${environment}-${appName}-<resource>`, e.g.
`acme-dev-messaging-hub-messaging-templates`. Change `organization`/`appName` and every
queue, table, bucket, bus, rule and Lambda is renamed consistently.

Two more values are **environment-specific rather than branding**, and must be set before
the first deploy of each environment:

```yaml
monitoring:
  alarmEmail: "oncall@example.com"   # who receives alarm notifications
tags:
  product: "Infrastructure"          # value of the Product tag
  owner: "CloudTeam"                 # value of the Owner tag — your team
```

### What the YAML governs

Beyond naming, the environment file owns every **operational policy**, so no behaviour
change requires touching code:

| Block | Governs |
|-------|---------|
| `organization`, `appName` | Resource naming prefix (rebranding) |
| `primaryRegion`, `secondaryRegion` | Single vs multi-region (see Multi-region) |
| `retainData` | RETAIN + deletion protection vs DESTROY on teardown |
| `audit.*` | WORM on/off + mode, Object Lock window, archive tier + timing, **expiry**, Firehose buffering |
| `observability.*` | Log retention, log level, event logging, X-Ray tracing on/off |
| `monitoring.alarmEmail`, `monitoring.alarms.*` | Alarm recipient, thresholds, periods, evaluation periods |
| `failover.*` | Latency threshold/period that trips the multi-region health check |
| `sqs.*` | Queue names, visibility timeout, `maxReceiveCount`, DLQ retention |
| `code.lambda.*` | Function names, entry points, memory, timeout |
| `sms.senderId` | Optional SMS Sender ID (omitted when empty) |
| `tags.*` | `Product` / `Owner` tag values |

What deliberately stays in code: runtime (Node.js 22), architecture (arm64), bundling,
encryption choices, and the alarm comparison operators. These are framework decisions, not
per-environment policy — changing them changes the architecture, not its configuration.

```yaml
observability:
  logRetentionDays: 90     # CloudWatch accepts discrete values only; validated at synth
  logLevel: "INFO"         # DEBUG | INFO | WARN | ERROR | CRITICAL | SILENT
  logEvent: true           # log the full event — verbose; shipped as false in prod
  tracing: true            # drives BOTH Tracing.ACTIVE and POWERTOOLS_TRACE_ENABLED

monitoring:
  alarms:
    evaluationPeriods: 1
    dlqDepth:        { threshold: 1,   periodMinutes: 1 }
    lambdaErrors:    { threshold: 1,   periodMinutes: 5 }
    lambdaThrottles: { threshold: 1,   periodMinutes: 5 }
    queueAge:        { threshold: 300, periodMinutes: 1 }   # threshold in SECONDS

failover:                  # only read when secondaryRegion is set
  latencyThresholdMs: 30000
  periodMinutes: 1
  evaluationPeriods: 5
```

`observability.logRetentionDays` is validated at synth time against the discrete set
CloudWatch accepts, so a typo fails fast with the allowed values listed instead of erroring
mid-deploy. `observability.tracing` drives both the Lambda tracing mode and the Powertools
env var from one flag, so they cannot drift out of sync.

The SSM path holding the target AWS Account ID is **derived** as
`/${appName}/${environment}/account`, so renaming the app moves the path with it. Override
it with an explicit `account:` key only if your org uses a different Parameter Store
convention.

> The committed `env/env-dev.yml` is a working development config and contains a real
> `alarmEmail`; `env-qa.yml`/`env-prod.yml` ship with `example.com` placeholders you must
> replace. Same for the SES sender in `dynamodb-items.txt`.

The message routing key is the event `detail` (`product`, `channel`, `feature`,
`language`) — so a single deployment can serve many products/tenants without code changes.

### Per-environment posture (as committed)

| | dev | qa | prod |
|---|:---:|:---:|:---:|
| `secondaryRegion` (multi-region) | `us-west-2` ✅ | — | — |
| `retainData` (RETAIN + deletion protection) | ❌ | ✅ | ✅ |
| `audit.worm` (Object Lock) | ❌ | ❌ | ✅ GOVERNANCE |
| `audit.expirationDays` (audit deletion) | keep forever | keep forever | 730 days |
| `observability.logEvent` (full-event logging) | ✅ | ✅ | ❌ |
| `observability.tracing` (X-Ray) | ✅ | ✅ | ✅ |
| Synthesized alarms | 17 (8×2 + endpoint) | 8 | 8 |

These are **independent** axes. dev deliberately runs without retention or Object Lock: it
is a throwaway environment under constant iteration, and immutable objects would make
teardown impossible. Multi-region is currently exercised in dev; enable it for qa/prod by
setting `secondaryRegion` there. `logEvent` ships off in prod because full-event logging
dominates the CloudWatch bill at volume (see [`docs/cost.md`](./docs/cost.md)) — turn it on
temporarily when debugging.

The message routing key is the event `detail` (`product`, `channel`, `feature`,
`language`) — so a single deployment can serve many products/tenants without code changes.

---

## Project Structure

```
messaging-hub/
├── bin/cdk.ts                          # CDK entry point (async: resolves account from SSM)
├── env/                                # Per-environment configuration (portability lives here)
│   ├── env-dev.yml
│   ├── env-qa.yml
│   └── env-prod.yml
├── lib/
│   ├── architecture-stack.ts           # Root stack (per region) — orchestrates the nested stacks
│   ├── global-endpoint-stack.ts        # Top-level stack — EventBridge Global Endpoint (deployed last)
│   ├── nested/                         # Nested stacks (Database, Buckets, Events, Audit, IAM, Monitoring)
│   ├── databases/dynamodb.ts           # DynamoDB tables (templates + idempotency; Global Tables when multi-region)
│   ├── buckets/buckets.ts              # S3 bucket (HTML templates, region in name)
│   ├── event-bridge/
│   │   ├── buses.ts                    # Custom EventBus
│   │   └── message-rules.ts            # Rules + SQS queues + DLQ + Lambdas
│   ├── audit/audit.ts                  # Audit bucket (WORM in prod) + Firehose + Glue + SES config set
│   ├── monitoring/monitoring.ts        # SNS alarm topic + CloudWatch alarms
│   ├── global-endpoint/global-endpoint.ts  # Global Endpoint construct (used by global-endpoint-stack.ts)
│   ├── iam/policies.ts                 # IAM policies (ARN-scoped; see Least privilege below)
│   └── utils/                          # Framework constants, typed interfaces, Lambda factory
├── src/aws-lambdas/
│   ├── src/
│   │   ├── controllers/                # Lambda handlers (Email, SMS)
│   │   ├── services/                   # Business logic (idempotent send + audit)
│   │   ├── aws/                        # Singleton SDK clients
│   │   ├── common/                     # Shared: BusinessError, Validator, constants
│   │   ├── utils/                      # SESConfig (template/config resolution), shared types
│   │   ├── libs/functions/             # DynamoDB, S3, Handlebars, Idempotency, Audit
│   │   └── libs/validators/            # Zod schemas for payload validation
│   ├── templates/demo/                 # Demo HTML templates (welcome en/es)
│   └── test/                           # Lambda unit tests (Vitest)
├── test/                               # CDK infrastructure tests (Vitest + assertions)
├── dynamodb-items.txt                  # DynamoDB seed data (2 demo records)
├── events.json                         # Sample EventBridge event
└── vitest.config.ts
```

---

## Prerequisites

- Node.js v22.x or later
- AWS CLI configured with credentials
- AWS CDK CLI (`npm install -g aws-cdk`)
- An SSM parameter holding the target AWS Account ID (see below)

## Installation

```bash
npm install                 # root (CDK)
npm --prefix src/aws-lambdas install   # Lambda functions
```

## Why the account ID comes from SSM (and how it's resolved)

CDK's `env.account` must be a **concrete** value at synth time — it cannot be a
deploy-time token like `{{resolve:ssm:...}}`. The account ID is therefore read from
SSM Parameter Store with an SDK call inside an `async main()` in `bin/cdk.ts`, before
the stack is defined. This keeps stack definition + tagging deterministic and surfaces
errors with a non-zero exit code (no floating promises).

Create the parameter once per account before the first deploy:

```bash
aws ssm put-parameter --name "/messaging-hub/dev/account" --value "123456789012" --type String
```

---

## Deploy

```bash
cdk bootstrap -c env=dev     # first time only per account/region
cdk synth     -c env=dev     # validate / render CloudFormation
cdk deploy    -c env=dev     # single-region (secondaryRegion empty)
```

Available environments: `dev`, `qa`, `prod`. Each environment resolves its own SSM
account parameter (`/messaging-hub/<env>/account`), so create that parameter in the target
account before deploying that environment.

**Multi-region deploy (when `secondaryRegion` is set):** bootstrap the secondary region
and deploy the stacks **in order** — the primary owns the DynamoDB Global Tables; the
secondary imports the replicas by name; the Global Endpoint is a **separate stack deployed
last** (it requires the event bus to exist in BOTH regions):

```bash
cdk bootstrap aws://<ACCOUNT_ID>/<secondaryRegion> -c env=dev   # first time only
cdk deploy dev-architecture-messaging-hub            -c env=dev  # 1) primary (Global Tables + consumers)
cdk deploy dev-architecture-messaging-hub-<secondaryRegion> -c env=dev  # 2) secondary consumer plane
cdk deploy dev-global-endpoint-<appName>             -c env=dev  # 3) Global Endpoint (needs both buses)
```

> Deploy strictly in this order: the secondary imports the Global Table replica created by
> the primary, and the endpoint requires the bus to exist in both regions.

> **Data retention (`retainData`):** `true` (qa/prod) keeps the DynamoDB tables (RETAIN +
> deletion protection) and the audit bucket (RETAIN); `false` (dev) uses DESTROY so failed
> deploys and teardowns self-clean. This is **independent** from audit immutability.

> **Audit immutability (`audit.worm`):** Object Lock (WORM) is enabled in **production
> only**, in **COMPLIANCE** mode; dev/qa capture the same audit records without WORM.

> **After the first deploy**, confirm the SNS email subscription from the inbox of
> `monitoring.alarmEmail` — until confirmed, alarm notifications are not delivered.

> ### ⚠️ Migrating an environment deployed before managed log groups
>
> Lambda auto-creates `/aws/lambda/<functionName>` on first invocation. Those implicit
> groups are **not** owned by CloudFormation, so the first deploy that introduces the
> managed log groups fails with
> `Resource of type 'AWS::Logs::LogGroup' with identifier '...' already exists`.
>
> Delete the orphan groups once, per region, before deploying (this discards their existing
> log events):
>
> ```bash
> for r in us-east-1 us-west-2; do
>   for f in send-email send-sms; do
>     aws logs delete-log-group --region "$r" \
>       --log-group-name "/aws/lambda/acme-dev-messaging-hub-$f" 2>/dev/null
>   done
> done
> ```
>
> Fresh environments are unaffected.

## Post-Deploy runbook

Explicit steps to make the system ready and test it. Steps marked **(multi-region)** apply
only when `secondaryRegion` is set.

### 1. Confirm SES identities (per region)
SES is **per region**, and new accounts start in **sandbox** (you can only send from/to
verified identities). Verify the sender in every region you deploy to; while in sandbox,
verify the recipients too.

```bash
aws sesv2 create-email-identity --email-identity <sender@your-domain> --region us-east-1
# (multi-region) repeat in the secondary region:
aws sesv2 create-email-identity --email-identity <sender@your-domain> --region us-west-2
```
Click the verification link AWS emails to each address. For production, verify a domain and
request sandbox exit (see the SES section below).

### 2. Seed DynamoDB (primary region only — 2 demo records)
Edit `dynamodb-items.txt` (table name + a **verified** SES sender), then run its **2**
`put-item` commands (`email#welcome#en`, `email#welcome#es`).

```bash
# run the two commands in dynamodb-items.txt against the PRIMARY region table
```
> **(multi-region)** Do **not** seed the secondary region — the DynamoDB **Global Table**
> replicates the items automatically.

### 3. Upload HTML templates to S3 (each region's bucket)
Bucket names include the region because S3 names are global.

```bash
aws s3 cp src/aws-lambdas/templates s3://acme-dev-messaging-hub-html-storage-us-east-1/ --recursive
# (multi-region) also upload to the secondary region's bucket:
aws s3 cp src/aws-lambdas/templates s3://acme-dev-messaging-hub-html-storage-us-west-2/ --recursive
```

### 4. Confirm the alarm subscription
Confirm the SNS email subscription sent to `monitoring.alarmEmail` (else alarms won't
notify).

### 5. Send a test event

Single-region — publish to the bus (console → EventBridge → Event buses → Send events, or CLI):

```bash
aws events put-events --region us-east-1 --entries '[{
  "EventBusName": "acme-dev-messaging-hub-messages-bus",
  "Source": "eventbridge.messages",
  "DetailType": "email",
  "Detail": "{\"idempotencyKey\":\"demo-welcome-jane-0001\",\"language\":\"es\",\"product\":\"demo\",\"feature\":\"welcome\",\"channel\":\"email\",\"mail\":\"<verified-recipient>\",\"name\":\"Jane\"}"
}]'
```

> **(multi-region)** Producers should publish to the **Global Endpoint** instead of a
> single bus, using `PutEvents` with the `EndpointId` of the `AWS::Events::Endpoint`
> (`acme-dev-messaging-hub-endpoint`). Get it with:
> ```bash
> aws events describe-endpoint --name acme-dev-messaging-hub-endpoint --region us-east-1
> ```
> This requires SigV4A signing — the AWS CLI v2 bundles it, but application SDKs need the CRT
> package installed. See [`docs/producer-integration.md`](./docs/producer-integration.md).

### 6. Verify
- The email arrives (check the recipient inbox).
- **Idempotency**: an item exists in `acme-dev-messaging-hub-idempotency`; re-sending the
  same `idempotencyKey` does **not** send a second email.
- **Audit**: a Parquet record lands under `s3://…-audit-<region>/data/dt=…/` and SES
  delivery events under `…/ses-events/…`; query with Athena (`messages`, `ses_events`).
- **Failure path**: a bad payload (or unverified recipient in sandbox) lands in the DLQ and
  triggers the `*-dlq-not-empty` alarm.
- **Delivery outcome**: see below — a log line saying "sent" only means SES *accepted* it.

---

## Did the message actually arrive?

This is the question the audit trail exists to answer, and it needs two separate facts:

| Level | Where | What it proves |
|-------|-------|----------------|
| **Acceptance** | Lambda log + `messages` table (`status = ACCEPTED`, `providerMessageId`) | AWS took the message. **Not** that anyone received it |
| **Outcome** | `ses_events` table (`Delivery` / `Bounce` / `Complaint` / `Reject`) | What the receiving provider did with it |

Two **saved Athena queries** are deployed with the stack, so you do not have to write SQL.
Open Athena → *Saved queries* in the region you deployed to:

| Saved query | Answers |
|-------------|---------|
| `${prefix}-delivery-outcome` | Per message: accepted, hashed recipient, and the real outcome (`DELIVERED` / `BOUNCED` / `COMPLAINT` / `REJECTED`, or `NULL` if no event has arrived yet) |
| `${prefix}-delivery-problems` | Everything that did **not** reach an inbox: hard bounces, complaints, rejections **and silently spam-filtered messages** |

Spam filtering is the subtle case. A message dropped into the spam folder still reports
`Delivery` with SMTP `250 OK` — the giveaway is a marker inside the response text:

```
250 2.0.0 OK DMARC:Quarantine …   ← accepted, delivered, and quarantined as spam
```

The `delivery-problems` query matches on those markers explicitly, which is why it catches
cases the bounce type alone would hide. Sample real output from
[`docs/e2e-evidence.md`](./docs/e2e-evidence.md):

| idempotencykey | accepted | outcome | provider_response |
|---|---|---|---|
| `e2e-t1` | ACCEPTED | DELIVERED | `250 2.0.0 OK … DMARC:Quarantine` |
| `e2e-gz-check-1` | ACCEPTED | **BOUNCED** | `smtp; 550-5.7.1 … Gmail ha…` |

> Persistent `DMARC:Quarantine` or spam blocks are a **sender reputation** problem, not a bug
> in the pipeline. Fix it by verifying a sending **domain** with DKIM + SPF + DMARC instead of
> a bare email address (see the SES section).

---

## Message Contract

The `detail` object of the EventBridge event drives everything:

| Field | Email | SMS | Notes |
|-------|:-----:|:---:|-------|
| `idempotencyKey` | ✅ | ✅ | **Required** — producer-supplied, immutable unique ID. Charset `[A-Za-z0-9_-]` (max 256, SES-tag-safe). Drives dedup + audit correlation |
| `product` | ✅ | ✅ | DynamoDB partition key (tenant/product) |
| `channel` | ✅ | ✅ | `email` or `sms` |
| `feature` | ✅ | ✅ | e.g. `welcome` — part of the sort key |
| `language` | ✅ | ✅ | e.g. `en`, `es` — part of the sort key |
| `mail` | ✅ | — | string **or** array of emails |
| `phoneNumber` | — | ✅ | E.164 format |
| any extra keys | ✅ | ✅ | passed to Handlebars (`{{name}}`, ...) |

DynamoDB key: partition `product`, sort `filterKey = "<channel>#<feature>#<language>"`.

> **Publishing this event:** see [`docs/producer-integration.md`](./docs/producer-integration.md)
> for the `PutEvents` call, IAM policy and runnable Python/TypeScript examples. Two things
> integrators trip on: `PutEvents` returns HTTP 200 even when an entry fails (always check
> `FailedEntryCount`), and the same `idempotencyKey` must be reused across retries for
> deduplication to work.

- **Email** body: HTML stored in **S3**, located via the `templatePath` attribute of the
  DynamoDB item (single source of truth — no derived naming convention).
- **SMS** body: template text stored **inline** in the DynamoDB item's `template`
  attribute.

> **Idempotency, audit & non-repudiation (✅ implemented):** the producer-supplied
> `idempotencyKey` drives exactly-once delivery (DynamoDB + Powertools Idempotency, TTL
> per template via the `idempotencyTtlSeconds` template attribute, default 1 day) and a
> durable audit trail — synchronous SES/SNS acceptance (`providerMessageId`, recipient
> hashed; stored as **Parquet** via native Firehose conversion) plus asynchronous SES
> delivery/bounce/complaint events (kept as raw **JSON** for a complete forensic record)
> → S3 (WORM), queryable with Athena. See [`docs/idempotency-and-audit.md`](./docs/idempotency-and-audit.md)
> and [`docs/compliance.md`](./docs/compliance.md).

---

## Batch size (do not change)

The SQS → Lambda event source mapping uses `batchSize: 1` **by design**, and this must
not be changed. The handlers process a single record (`event.Records[0]`) and rely on
all-or-nothing retry semantics per message:

- On success, Lambda deletes the one message from the queue.
- On error, the message returns to the queue and is retried until `maxReceiveCount` (3),
  after which it lands in the DLQ.

Increasing `batchSize` would silently drop records `1..n` on the current code path and
break per-message retry isolation. If higher throughput is ever needed, the correct path
is to refactor the handlers to loop over `event.Records` **and** enable
`ReportBatchItemFailures` (partial batch responses) — not to bump `batchSize` alone.

---

## Encryption (decision record)

PII (email addresses, phone numbers, names) flows through the system, so encryption is
applied at every hop.

> **Scope note.** These are technical controls, not a compliance certification. The recipient
> is hashed in the acceptance trail, but the **raw SES delivery events keep the address in
> clear text**, and there is no automated data-subject erasure workflow. Read
> [`docs/compliance.md`](./docs/compliance.md) before using this for regulated personal data.

| Layer | Mechanism | Rationale |
|-------|-----------|-----------|
| **SQS at rest** | **SSE-SQS** (`QueueEncryption.SQS_MANAGED`) on all 4 queues incl. DLQs | Message bodies carry PII. SSE-SQS is chosen over SSE-KMS to avoid per-request KMS costs and extra key-policy management. If a compliance regime requires a customer-managed key (CMK) with rotation/audit, switch to `QueueEncryption.KMS` and grant the Lambda roles `kms:Decrypt`. |
| **SQS in transit** | `enforceSSL: true` | A queue policy denies any request where `aws:SecureTransport=false`. |
| **S3 at rest** | **SSE-S3** (`BucketEncryption.S3_MANAGED`) | Templates are non-sensitive HTML; SSE-S3 is sufficient and cost-free. `BLOCK_ALL` public access is enforced. |
| **Audit bucket** | SSE-S3 + `enforceSSL` + **optional Object Lock (WORM)** + configurable archive/expiry | Non-repudiation trail. Prod ships WORM in **GOVERNANCE** mode with a 730-day expiry: immutable against accidents while keeping a break-glass deletion path. `COMPLIANCE` is available but blocks all deletion during retention — see [`docs/compliance.md`](./docs/compliance.md). dev/qa capture the same records without WORM. `audit.worm` is independent from `retainData`. |
| **DynamoDB at rest** | AWS-owned key (`TableEncryption.DEFAULT`) | Table stores template metadata only. Upgrade to `AWS_MANAGED`/CMK if item content becomes sensitive. |
| **Lambda ↔ AWS APIs** | TLS (SDK default) | All SES/SNS/S3/DynamoDB calls use HTTPS. |

Trade-off summary: **SSE-SQS** was selected for the PII-bearing queues as the best
balance of security and cost. The only reason to move to KMS-CMK is an explicit
compliance/audit requirement.

See [`docs/compliance.md`](./docs/compliance.md) for the full compliance posture (PII
handling, retention, non-repudiation, WORM, resilience).

---

## Least privilege (what is scoped, and what cannot be)

Each Lambda gets its own role with ARN-scoped permissions (`lib/iam/policies.ts`):

| Permission | Scope | Note |
|------------|-------|------|
| `ses:SendEmail`, `ses:SendRawEmail` | `identity/*` + `configuration-set/*` in **this** account/region | The sender comes from the DynamoDB template item at runtime, so it cannot be pinned at synth time; `identity/*` is the tightest static scope |
| `sns:Publish` | `*` | **Unavoidable.** Direct SMS publishing targets a `PhoneNumber`, not a topic ARN — SNS exposes no resource to scope against |
| `s3:GetObject` | templates bucket only (`<bucket>/*`) | No `ListBucket` |
| DynamoDB templates | `grantReadData` | Read-only |
| DynamoDB idempotency | `grantReadWriteData` | Powertools needs Get/Put/Update/Delete |
| `firehose:PutRecord`, `PutRecordBatch` | audit stream ARN only | |
| `xray:PutTraceSegments`, `PutTelemetryRecords` | `*` | Added automatically by CDK for active tracing; X-Ray has no resource-level scoping |

The queue-consume permissions are granted by the `SqsEventSource` mapping, not here.

---

## Monitoring (implemented)

Observability baseline shipped in the CDK (`lib/monitoring/`, deployed as the
`MonitoringNestedStackConstruct` nested stack):

- **Structured logging** via AWS Lambda Powertools `Logger`, into a **dedicated CloudWatch
  Log Group per function** (`/aws/lambda/<functionName>`, retention from
  `observability.logRetentionDays`, shipped at **3 months**). The group is created by
  CloudFormation rather than implicitly by Lambda, because only a managed group can carry a
  retention policy and be torn down with the stack. It follows `retainData`: RETAIN in
  qa/prod, DESTROY in dev.
- **Distributed tracing** via Powertools `Tracer` with **X-Ray active tracing**, toggled by
  `observability.tracing`; CDK attaches the X-Ray write permissions. Note that the
  `POWERTOOLS_TRACE_ENABLED` env var alone does nothing — active tracing at the Lambda
  service level is what makes segments appear, which is why one config flag drives both.
  Tracing samples at the X-Ray default; see the cost levers in
  [`docs/cost.md`](./docs/cost.md).
- **SNS alarm topic** (`${prefix}-alarms`) with an **email subscription**. The recipient
  is configured in the env YAML (`monitoring.alarmEmail`). Every alarm notifies on both
  `ALARM` and `OK`, so you see the incident and its resolution.

  > After the first deploy, confirm the SNS subscription from the email inbox — SNS email
  > subscriptions stay `PendingConfirmation` until the recipient clicks the link.

- **CloudWatch alarms (8 per region, per channel × email/sms).** In a multi-region
  deployment that is 8 per region plus the Global Endpoint latency alarm (17 for dev):

  | Alarm | Metric | Condition | Why |
  |-------|--------|-----------|-----|
  | `*-dlq-not-empty` | SQS `ApproximateNumberOfMessagesVisible` (DLQ) | `>= 1` | A message exhausted all retries — highest signal |
  | `*-lambda-errors` | Lambda `Errors` | `>= 1` (5 min) | Processing failures |
  | `*-lambda-throttles` | Lambda `Throttles` | `>= 1` (5 min) | Concurrency starvation |
  | `*-queue-age` | SQS `ApproximateAgeOfOldestMessage` | `> 300s` | Stuck / backed-up consumer |

The thresholds and periods in the table above are the shipped defaults; all of them come
from `monitoring.alarms` in the environment YAML, so they can be tuned per stage without
code changes:

```yaml
monitoring:
  alarmEmail: "oncall@example.com"
  alarms:
    evaluationPeriods: 1
    dlqDepth:        { threshold: 1,   periodMinutes: 1 }
    lambdaErrors:    { threshold: 1,   periodMinutes: 5 }
    lambdaThrottles: { threshold: 1,   periodMinutes: 5 }
    queueAge:        { threshold: 300, periodMinutes: 1 }   # SECONDS
```

### Future work (not yet automated)

1. **SES bounce/complaint suppression** — the Configuration Set already captures all five
   event types (`send`, `delivery`, `bounce`, `complaint`, `reject`) into the audit trail
   (SES → Firehose → S3). A suppression list that auto-blocks repeat bouncing addresses is
   the remaining piece before high SES volume.
2. **CloudWatch dashboard** — queue depth, Lambda duration/errors, SES/SNS volume.
3. **X-Ray sampling rule** — tracing is active at the X-Ray default; an explicit sampling
   rule (5–10%) would cut the tracing bill sharply at volume.

---

## Multi-region (EventBridge Global Endpoint)

Regional fault tolerance is **opt-in** via config. With `secondaryRegion` empty (default),
the stack is single-region. Set it to enable multi-region:

```yaml
primaryRegion: "us-east-1"
secondaryRegion: "us-west-2"   # enables Global Endpoint + Global Tables
```

When enabled, `bin/cdk.ts` deploys the stack to **both** regions:

- **Primary** owns the stateful/global resources: the DynamoDB **Global Tables**
  (`messaging-templates` + `idempotency`, replicated to the secondary) and the
  **EventBridge Global Endpoint** (`AWS::Events::Endpoint`) with event replication.
- **Secondary** deploys the consumer plane (bus with the **same name**, rules, queues,
  Lambdas, audit) and **imports** the Global Table replicas by name.

Failover: a CloudWatch alarm on `IngestionToInvocationStartLatency` drives a Route 53 health
check; when unhealthy, the endpoint routes events to the secondary bus. The trigger is
configured in the `failover` block (shipped at > 30s sustained for 5 one-minute periods).

**Producers must publish to the endpoint** (`PutEvents` with `EndpointId`), which has two
requirements that are easy to miss:

- The **AWS CRT** package for their SDK (`awscrt` for Python, `@aws-sdk/signature-v4-crt` for
  Node) — global endpoints sign with **SigV4A**, which the base SDK cannot do.
- `events:PutEvents` on the bus ARN in **both** Regions, since the endpoint may route to
  either one.

Failover also takes several minutes to trigger, so producers need retries with backoff to
avoid losing events in that window. Full setup, IAM policy and working Python/TypeScript
examples: [`docs/producer-integration.md`](./docs/producer-integration.md).

Residual risk (documented in `docs/compliance.md`): DynamoDB Global Tables are eventually
consistent, so a brief duplicate-send window is possible during failover.

Operational notes: SES identities and SNS SMS must be configured **per region**; upload
HTML templates to each region's bucket.

---

## Cost

At **1M emails/month** (multi-region), the estimate is **~$135/month**, of which **SES is
~$100 (≈74%)**; the multi-region overhead over a single region is only ~$15–20/month, and
idempotency keeps SES at one send (avoiding a ~$200 double bill). SMS is excluded
(country-dependent). Full breakdown and cost levers in [`docs/cost.md`](./docs/cost.md).
Use the [AWS Pricing Calculator](https://calculator.aws/) for authoritative figures.

---

## Amazon SES Configuration (Email)

New AWS accounts start with SES in **sandbox** mode: you can only send to verified
identities. For production you must exit the sandbox, which requires a verified domain.

### Multi-account model (recommended)

Run each environment in a separate AWS account, each with its own verified subdomain, so
sending reputation and DKIM tokens are isolated. Replace `example.com` with your domain.

| Environment | SES Domain | Sender | Hosted Zone |
|-------------|------------|--------|-------------|
| dev | `dev.example.com` | `Acme <no-reply@dev.example.com>` | `dev.example.com` in dev account |
| qa | `qa.example.com` | `Acme <no-reply@qa.example.com>` | `qa.example.com` in qa account |
| prod | `example.com` | `Acme <no-reply@example.com>` | `example.com` in prod account |

High-level steps (see AWS docs for details):

1. **Create a public hosted zone** for the subdomain in the environment account and copy
   its 4 nameservers.
2. **Delegate** the subdomain from the parent zone (prod account) with an `NS` record.
   Verify with `dig NS dev.example.com @8.8.8.8`.
3. **Verify the domain in SES** (Easy DKIM, RSA_2048, custom MAIL FROM
   `mail.dev.example.com`). SES auto-creates the DKIM CNAMEs, MX and SPF/DMARC records in
   the hosted zone.
4. **While in sandbox**, also verify each test recipient address.
5. **Request production access** (SES → Account Dashboard → Request Production Access).
   Choose **Transactional**, describe the opt-in transactional use case, and state your
   bounce/complaint handling plan. Sandbox exit is **per account and per region**.
6. **After approval**, configure bounce/complaint SNS notifications and suppression (see
   Monitoring §3).

### Amazon SNS (SMS)

SMS is sent as **Transactional** (`AWS.SNS.SMS.SMSType = Transactional`). A **Sender ID**
is optional and region-restricted (not supported in the US/Canada, max 11 alphanumeric
chars); set `sms.senderId` in the env YAML to include it, or leave it empty to omit it.
Before production SMS: verify a phone number in the SNS SMS sandbox, request sandbox exit,
and review per-country cost.

---

## Tests

Two independent suites:

```bash
# CDK / infrastructure assertions (aws-cdk-lib/assertions)
npm test

# Lambda unit tests (Zod schemas, SES template builder, Handlebars, SMS attributes)
npm --prefix src/aws-lambdas test
```

The CDK tests run with bundling disabled, so they assert on synthesized CloudFormation
without invoking esbuild. Coverage: DynamoDB Global Tables + TTL, bucket privacy/versioning,
queue encryption, SSL enforcement, DLQ redrive, EventBridge patterns, runtime/arch,
`batchSize`, log group retention, X-Ray tracing, the 8 alarms and their ALARM/OK actions,
audit (Object Lock on/off, Parquet vs raw JSON, Glue tables, SES config set), the Global
Endpoint with replication + health check, and IAM scoping.

---

## Resilience

- **DLQ**: each queue has a Dead Letter Queue; messages failing 3 times are moved there
  for inspection.
- **Automatic retries**: on Lambda failure the message returns to the queue.
- **Visibility timeout**: 30s — aligned with the Lambda timeout.
- **SSL enforced** and **SSE-SQS** on all queues (see Encryption).

## Independent Lambdas

Email and SMS are separate Lambda functions, each with its own SQS queue and DLQ, enabling
independent scaling, fault isolation, and per-channel memory/timeout/monitoring.

## Cleanup

```bash
cdk destroy -c env=dev
```

What `cdk destroy` removes depends on `retainData` for that environment:

| Resource | `retainData: false` (dev) | `retainData: true` (qa/prod) |
|----------|---------------------------|------------------------------|
| DynamoDB `messaging-templates` | DESTROY, no deletion protection | **RETAIN** + deletion protection → remove manually |
| DynamoDB `idempotency` | DESTROY | **DESTROY** (always — it holds only transient dedup records) |
| Audit bucket | DESTROY + `autoDeleteObjects` | **RETAIN** → remove manually |
| Lambda log groups | DESTROY | **RETAIN** → remove manually |
| S3 template bucket | DESTROY + `autoDeleteObjects` (always) | DESTROY + `autoDeleteObjects` (always) |

The template bucket uses `autoDeleteObjects` unconditionally, so it is removed cleanly even
with versioned objects. In **prod** the audit bucket has Object Lock in COMPLIANCE mode:
objects cannot be deleted until their retention expires, not even by root — so a prod
teardown leaves the audit bucket behind by design.

In multi-region, destroy in reverse order: Global Endpoint stack → secondary → primary.
Afterwards, verify no orphan resources remain in CloudWatch Logs, S3, and DynamoDB.

---

## Attribution and licence

This project is a derivative of the AWS sample
[`aws-samples/sample-serverless-messaging-hub`](https://github.com/aws-samples/sample-serverless-messaging-hub)
(baseline commit `9942f22`), extended with idempotency, an audit/non-repudiation trail,
monitoring, multi-region failover and a portable configuration model. See
[`CHANGELOG.md`](./CHANGELOG.md) for the full record of what changed.

Licensed under **MIT No Attribution (MIT-0)** — see [`LICENSE`](./LICENSE).
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

Contribution guidelines are in [`CONTRIBUTING.md`](./CONTRIBUTING.md) and the code of conduct
in [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md); both are inherited from the upstream sample
and point at AWS's processes, so adjust them if this becomes an independently maintained
repository.

## Security

If you discover a potential security issue in the **upstream sample**, report it via the
[AWS vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/)
rather than opening a public issue. For this derivative, follow your own organisation's
disclosure process.
