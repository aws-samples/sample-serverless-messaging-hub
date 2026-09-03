# Compliance — Messaging Hub

Security and data-protection **controls** implemented in this stack.

> ## What this document is, and is not
>
> This is an **engineering inventory of technical controls**. It is **not** a statement of
> compliance with GDPR, CCPA, HIPAA, SOC 2, ISO 27001 or any other regime, and it has not
> been reviewed by legal or privacy counsel.
>
> The stack gives you building blocks — encryption, least privilege, hashing of the recipient
> in the acceptance trail, configurable retention, optional immutability, an auditable trail.
> Whether a given deployment *complies* with a regulation depends on your legal basis for
> processing, your data-subject request process, your retention schedule, your DPA with AWS
> and your own organisational controls. None of that lives in this repository.
>
> Two gaps are known and deliberately documented rather than papered over:
>
> 1. The raw SES delivery events contain the **recipient address in clear text** — see
>    [PII in the SES delivery events](#-pii-in-the-ses-delivery-events).
> 2. There is **no automated data-subject erasure mechanism**. Deletion is a manual,
>    operator-driven action, and its feasibility depends on your `audit.worm` /
>    `audit.wormMode` configuration.
>
> Treat unresolved items as work for whoever adopts this, not as solved problems.

> **Status legend:** ✅ Implemented · ⚠️ Implemented with a caveat · 🔜 Planned.
> Idempotency, audit/non-repudiation and multi-region are **implemented** (Phases 0–1).
> Technical detail lives in [`idempotency-and-audit.md`](./idempotency-and-audit.md).

---

## Scope and data classification

The system processes **personal data (PII)** of transactional-notification recipients:

| Data | Where it appears | Handling |
|------|------------------|----------|
| Email | `detail.mail`, SQS queue, SES send | Encrypted at rest/in transit; **hashed** in the audit trail |
| Phone | `detail.phoneNumber`, SQS queue, SNS send | Encrypted at rest/in transit; **hashed** in the audit trail |
| Name and variables | `detail.*`, Handlebars render | Encrypted at rest/in transit; not persisted beyond sending |

**PII minimization** principle: in the **acceptance** audit record the recipient is stored
**hashed** (SHA-256), never in clear text. Verified against the live trail — the `messages`
table exposes only `recipienthash`.

### ⚠️ PII in the SES delivery events

The second audit stream (`ses-events/`) stores the SES event payload **verbatim**, and SES
includes the recipient in clear text. A single delivery record contains:

| Field | Content |
|-------|---------|
| `mail.destination[]` | recipient address, clear text |
| `delivery.recipients[]` | recipient address, clear text |
| `bounce.bouncedRecipients[].emailAddress` | recipient address, clear text |
| `mail.headers[]`, `mail.commonHeaders.to[]` | recipient address + **subject line** |
| `mail.tags['ses:source-ip']` | sending source IP |

This is a **deliberate trade-off, not an oversight**: a non-repudiation record must be the
unaltered provider payload, and redacting it would weaken its evidentiary value. Two
mitigations are in place:

1. The **Glue/Athena schema does not project** those fields, so the normal query path cannot
   surface a recipient address (verified: `SELECT mail.destination` fails with
   `COLUMN_NOT_FOUND`). Investigations join on `idempotencykey` and compare
   `messages.recipienthash` instead.
2. Bucket access is restricted (`BLOCK_ALL` public access, `enforceSSL`, SSE-S3).

**Retention is fully parameterizable, and the shipped defaults keep an erasure path open.**
Every knob lives in `audit.*` in the environment YAML — nothing about immutability or
retention is hardcoded:

| Key | Shipped default | Effect |
|-----|-----------------|--------|
| `worm` | `false` dev/qa · `true` prod | Object Lock on/off (create-time only; forces versioning) |
| `wormMode` | `GOVERNANCE` | `GOVERNANCE` → a principal with `s3:BypassGovernanceRetention` **can** delete. `COMPLIANCE` → **nobody** can, not even root |
| `objectLockRetentionDays` | `365` | How long objects are locked |
| `expirationDays` | `0` dev/qa · `730` prod | Lifecycle deletion. `0` = keep forever |
| `glacierTransitionDays` | `90` | When to archive |
| `glacierStorageClass` | `GLACIER` | `GLACIER` / `GLACIER_IR` / `DEEP_ARCHIVE` |

Prod ships **`GOVERNANCE` + `expirationDays: 730`** deliberately: the trail is immutable
against accidents and ordinary operators, retention is bounded, and a break-glass deletion
remains possible for a data-subject request. `COMPLIANCE` is one YAML change away if a
regulator requires that not even root can delete — but understand the consequence: the
clear-text recipient data above becomes **undeletable for the full retention window**, which
is irreconcilable with an erasure obligation. That is a decision for your privacy owner, not
a default this repo should make for you.

An impossible combination (an expiry inside the lock window, or an expiry before the archive
transition) is rejected at **synth time** with an explanatory error, so it cannot reach S3
and silently fail.

If you need the raw payload redacted at ingest instead, the extension point is a Firehose
**transform Lambda** on the `ses-events` stream — not implemented here, and it costs fidelity
of the provider payload, which is the evidence the trail exists to preserve.

---

## Encryption (data protection)

| Layer | Mechanism | Status |
|-------|-----------|--------|
| SQS at rest | SSE-SQS (`SQS_MANAGED`) on all 4 queues, incl. DLQs | ✅ |
| SQS in transit | `enforceSSL` (denies `aws:SecureTransport=false`) | ✅ |
| S3 templates at rest | SSE-S3 (`S3_MANAGED`) + `BLOCK_ALL` public + versioning | ✅ |
| DynamoDB at rest | AWS-owned key (`TableEncryption.DEFAULT`) | ✅ |
| Lambda ↔ AWS APIs | TLS (SDK default) | ✅ |
| S3 audit at rest | SSE-S3 + **Object Lock (WORM, COMPLIANCE) — prod only** | ✅ (prod) |

Decision: **SSE-SQS** on the PII-bearing queues as the best security/cost balance.
Migrate to **KMS-CMK** only if a compliance regime requires a customer-managed key with
rotation/audit. See the README "Encryption (decision record)".

---

## Access control (least privilege)

**Per-Lambda** IAM roles with ARN-scoped policies:

| Permission | Scope | Status |
|------------|-------|:------:|
| `ses:SendEmail`, `ses:SendRawEmail` | `identity/*` + `configuration-set/*` in this account/region | ✅ |
| `s3:GetObject` | templates bucket only (no `ListBucket`) | ✅ |
| DynamoDB templates | `grantReadData` (read-only) | ✅ |
| DynamoDB idempotency | `grantReadWriteData` (Powertools requirement) | ✅ |
| `firehose:PutRecord`, `PutRecordBatch` | audit stream ARN only | ✅ |
| `sns:Publish` | `*` — **unavoidable** | ⚠️ |
| `xray:PutTraceSegments`, `PutTelemetryRecords` | `*` — no resource-level scoping in X-Ray | ⚠️ |

The two `*` grants are API constraints, not gaps: direct SMS publishing targets a
`PhoneNumber` rather than a topic ARN, so SNS exposes no resource to scope against, and
X-Ray does not support resource-level permissions. Everything else is pinned to a specific
ARN. Queue-consume permissions come from the `SqsEventSource` mapping, not from these
policies.

- No public S3 access (`BLOCK_ALL`) on either bucket; `enforceSSL` on the audit bucket. ✅

---

## Idempotency / exactly-once (prevents duplicate sends)

- **Explicit, required** `idempotencyKey` in the event contract (producer-generated;
  charset `[A-Za-z0-9_-]`, max 256). ✅
- Deduplication with **DynamoDB + Powertools Idempotency**, `INPROGRESS`→`COMPLETED` flow,
  **per-template TTL (default 1 day)**. ✅
- Multi-region via **Global Table**; small residual duplicate window possible during
  failover due to eventual consistency (documented). ✅

Detail: [`idempotency-and-audit.md`](./idempotency-and-audit.md).

---

## Non-repudiation and audit trail

Evidence that a message was **accepted** and **delivered**:

- **Acceptance (synchronous):** SES/SNS `providerMessageId` → proves AWS accepted it. ✅
- **Delivery (asynchronous):** SES **Configuration Set** capturing all five event types
  (`send`, `delivery`, `bounce`, `complaint`, `reject`) and SNS *delivery status logging*,
  correlated by `idempotencyKey` (message tag). ✅
- **Immutable store:** S3 audit bucket; **acceptance in Parquet** (native Firehose
  conversion, columnar) and **SES events in raw JSON** (kept complete for non-repudiation);
  queried with **Athena**; recipient **hashed**. **Object Lock (WORM) is enabled in
  production only, in COMPLIANCE mode** (not even root can delete during the retention
  period); dev/qa capture the same records but the bucket is **not** immutable
  (mutable/deletable) — WORM and data-retention are decoupled config axes (`audit.worm`
  vs `retainData`). ✅ (prod immutability)
- **Per-region archiving** at send time (not from Global Table streams, to avoid double
  counting); optional consolidation via CRR. ✅

Acceptance-record fields: `idempotencyKey`, `product`, `channel`, `feature`, `language`,
hashed recipient, `status` (**`ACCEPTED` or `FAILED` only** — this record is written once at
send time and never updated), `providerMessageId`, `region`, `timestamp`. The delivery outcome
is **not** in this record; it lives in `ses_events.eventType`.

The two streams are joinable in Athena on the `idempotencyKey` SES message tag, producing a
single acceptance-to-outcome report per message. See the worked query in
[`idempotency-and-audit.md`](./idempotency-and-audit.md#querying-the-trail-athena).

---

## Data retention and lifecycle

| Data | Retention | Mechanism | Status |
|------|-----------|-----------|--------|
| Idempotency records | Dedup window (default 1 day, per template) | DynamoDB **TTL** (free automatic deletion) | ✅ |
| Audit (non-repudiation) | Archive at `glacierTransitionDays`, delete at `expirationDays` (prod: 90 / 730 days) | **S3 lifecycle** + optional Object Lock | ✅ |
| Lambda logs | 3 months (`observability.logRetentionDays`) | CloudWatch Logs retention on a **managed** log group per function | ✅ |
| DLQ messages | 14 days | SQS retention | ✅ |
| `templates` table | Persistent in **qa/prod** | `RETAIN` + deletion protection when `retainData: true` | ✅ |
| `idempotency` table | Not retained (transient by design) | `DESTROY` in every environment | ✅ |

**Environment-scoped by design:** `retainData` is `false` in dev and `true` in qa/prod. dev
is a throwaway environment under constant iteration, so retention and Object Lock are
deliberately off there — retained tables and immutable objects would block teardown and
leave orphans on every failed deploy. The three axes (`secondaryRegion`, `retainData`,
`audit.worm`) are configured independently per environment; see the posture table in the
README.

**Right to erasure — not automated. ⚠️** There is no data-subject request workflow in this
stack. What exists:

- Hashing the recipient in the **acceptance** trail limits exposure there (a SHA-256 of an
  email is not reversible in bulk, though it *is* checkable against a guessed address, so
  treat it as pseudonymised, **not** anonymised).
- The **SES delivery events keep the address in clear text** (above), so a genuine erasure
  needs those objects deleted.
- Whether that deletion is possible depends on your config: it is straightforward with
  `worm: false`, possible via break-glass with `worm: true` + `wormMode: GOVERNANCE`, and
  **impossible** with `COMPLIANCE` until retention expires.
- `expirationDays` gives you bounded retention, which addresses storage-limitation
  expectations but is **not** a substitute for per-subject deletion.

Anyone adopting this for regulated personal data needs to build the request-handling process
themselves and pick the `audit.*` configuration that matches it.

---

## Resilience and availability

| Control | Status |
|---------|--------|
| Per-channel DLQ, `maxReceiveCount=3`, automatic retries | ✅ |
| Visibility timeout aligned with the Lambda timeout (30s) | ✅ |
| Independent email/SMS channels (fault isolation) | ✅ |
| Multi-region with **EventBridge Global Endpoint** + Global Table + replication | ✅ (opt-in `secondaryRegion`) |

Reference: Security Hub CSPM **EventBridge.4** — "global endpoints should have event
replication enabled" (automatic recovery after failover).

---

## Monitoring and alerting

- Structured logging (Powertools `Logger`) into a CloudFormation-managed Log Group per
  function; retention from `observability.logRetentionDays` (3 months as shipped). ✅
- Distributed tracing (Powertools `Tracer`) with **X-Ray active tracing** enabled on both
  functions via `observability.tracing`. ✅
- Alarm thresholds, periods and evaluation periods are environment configuration
  (`monitoring.alarms`), not code — auditable and tunable per stage. ✅
- **8 CloudWatch alarms per region** (DLQ not empty, Lambda errors/throttles, queue age) →
  **SNS with email subscription**, notifying on both ALARM and OK. Multi-region adds the
  Global Endpoint ingestion-latency alarm. ✅
- Pending: SES bounce/complaint suppression list, SMS delivery dashboard, explicit X-Ray
  sampling rule. 🔜

---

## Status summary

| Domain | Implemented | Planned |
|--------|:---:|:---:|
| Encryption at rest/in transit (SQS/S3/DynamoDB/TLS) | ✅ | — |
| Least-privilege IAM | ✅ | — |
| Resilience (DLQ, retries, isolated channels) | ✅ | — |
| Monitoring + alerts | ✅ | — |
| Log retention (3 months) + X-Ray active tracing | ✅ | — |
| Idempotency / exactly-once | ✅ | — |
| Non-repudiation / audit trail, joinable in Athena; optional WORM immutability | ✅ | — |
| Delivery-outcome visibility (delivered / spam-quarantined / bounced / rejected) | ✅ | — |
| Lifecycle retention (dedup TTL, configurable archive + expiry) | ✅ | — |
| Clear-text recipient inside raw SES event objects | ⚠️ by design | — |
| Automated data-subject erasure workflow | ⚠️ not implemented | 🔜 |
| Multi-region (Global Endpoint/Table) | ✅ (opt-in) | — |
| Bounce suppression list / CloudWatch dashboard / X-Ray sampling rule | — | 🔜 |
