# Idempotency and audit (non-repudiation)

> **Status:** ✅ Implemented (Phases 0–1). This document describes the **what** and the
> **why** of the deduplication and audit/non-repudiation already built.
> Legend: ✅ implemented · 🔜 pending.

It solves two distinct needs that are often conflated:

1. **Deduplication (correctness):** avoid duplicate sends on SQS retries, replays or
   multi-region failover.
2. **Audit / non-repudiation (evidence):** be able to prove whether a message was accepted
   and delivered (or bounced), with a durable, tamper-evident record.

---

## 1. Deduplication (idempotency)

### Contract: explicit `idempotencyKey`

The **producer** must send an explicit idempotency identifier in the event `detail`. We do
not derive it: producing the event owns generating it.

```jsonc
{
  "detail-type": "email",
  "source": "eventbridge.messages",
  "detail": {
    "idempotencyKey": "b1f2-order-4821-welcome",  // required, unique, immutable
    "product": "demo",
    "channel": "email",
    "feature": "welcome",
    "language": "es",
    "mail": "user@example.com",
    "name": "Jane"
  }
}
```

- **Required.** An event without `idempotencyKey` fails validation (Zod) and goes to the
  DLQ without sending. This is a **breaking contract change** that must be announced to
  producers.
- **Immutable and unique per logical message.** The EventBridge event `id` does **not**
  work: it changes across API calls and during cross-region replication (as the global
  endpoints guide requires). It must be a stable business ID.
- **Charset `[A-Za-z0-9_-]` (max 256):** SES-message-tag-safe, so the same key can be
  attached as an SES message tag for delivery-event correlation.

### Physical table + Powertools

- **The DynamoDB idempotency table is created in CDK** (infrastructure). Powertools does
  **not** create infrastructure: it only manages the items inside it.
- Schema expected by Powertools (names configurable):
  - PK: `id` (holds the `idempotencyKey`)
  - `expiration` — the dedup window. TTL is enabled on it **single-region only**; the
    multi-region table is MRSC, which does not support TTL (the window is still enforced by
    the conditional write — see below)
  - `in_progress_expiration` — orphaned-lock recovery; only written when the Lambda context
    is registered
  - `status` (`INPROGRESS` / `COMPLETED`) managed by Powertools
- **Separate** table from `templates` (different access pattern and lifecycle).

### INPROGRESS → COMPLETED flow (why two phases)

A naive "mark-before-send" has a bug: if it marks *sent* and then **SES fails**, the retry
would be blocked and the message would **never be sent**. That is why Powertools uses two
phases:

1. `INPROGRESS` (conditional put `attribute_not_exists`, with a short safety expiry) → guard.
2. Send via SES/SNS.
3. `COMPLETED` (with the template TTL).
4. If the send fails → the record is released and the message returns to SQS to retry.

### Lambda context is required (`in_progress_expiry`)

The guard wraps an **isolated operation**, not the handler. In that shape Powertools cannot
discover the Lambda context by itself, so `runOnce` receives it explicitly and calls
`config.registerLambdaContext(context)`.

This is not cosmetic. The context is what lets Powertools write the in-progress expiry
attribute — stored as **`in_progress_expiration`** on the item, referenced as
`#in_progress_expiry` inside the expression — which in turn is what makes the third branch of
the conditional write reachable:

```
attribute_not_exists(#id)                       ← first time
OR #expiry < :now                               ← dedup window elapsed
OR (#status = :inprogress
    AND attribute_exists(#in_progress_expiry)   ← unreachable without the context
    AND #in_progress_expiry < :now_in_millis)
```

To confirm it is on, scan the idempotency table and check that items carry
`in_progress_expiration` alongside `id`, `status` and `expiration`.

That third branch is the only way to reclaim an **orphaned lock**. Without it, a function
killed *without throwing* (timeout, OOM, `Runtime.ExitError`) leaves the key `INPROGRESS`
for the full dedup window: every SQS redelivery raises `IdempotencyAlreadyInProgressError`,
the message reaches the DLQ within minutes and is **never sent**, with no recovery for up to
a day. If the code throws instead, Powertools releases the record and the retry succeeds —
the gap is specifically silent runtime death.

If you ever see `Could not determine remaining time left. Did you call registerLambdaContext
on IdempotencyConfig?` in the logs, this protection is off.

### Per-template TTL (default 1 day)

- The template configuration item (`templates` table) carries `idempotencyTtlSeconds`; if
  absent, **default 86400 (1 day)**.
- It is read **before** the guard (a side-effect-free read) and used as the `COMPLETED`
  record expiry.
- The window is enforced by the `#expiry < :now` branch of the **conditional write**, not by
  DynamoDB TTL. TTL only reclaims storage; correctness does not depend on it. This matters
  because the multi-region table runs without TTL (see below).
- Known limitation: the persistence layer is a module-level singleton and Powertools'
  `configure()` returns early once configured ("Prevent reconfiguration"). The per-template
  TTL is therefore only applied on the **first** invocation of a warm container; later
  templates in the same container silently reuse the first TTL. Fixing it requires one
  persistence-layer instance per distinct TTL.

### Multi-region: why the store is MRSC

In multi-region the table is a **DynamoDB global table with Multi-Region Strong Consistency
(MRSC)**, configured as 2 replicas + 1 witness (`databases.dynamodb.idempotencyWitnessRegion`).
Under MRSC, item changes are replicated **synchronously** before the write returns, and
**conditional writes are evaluated against the latest version of the item across Regions**.
`ConsistentRead` on `getRecord` also becomes authoritative cross-region.

That property is the whole reason for MRSC here, and it is not a theoretical nicety:

> With the EventBridge global endpoint's event replication **enabled**, both Regions process
> **every** event. On an eventually consistent (MREC) global table, both Lambdas issue
> `attribute_not_exists(id)` against their **local replica** within the replication lag, both
> claims succeed, and the message is sent **twice**. This was measured on this system: 4 out
> of 4 events produced two distinct `providerMessageId` values and two SMTP deliveries, with
> the two invocations starting ~180 ms apart. It is not a rare failover race — it was the
> steady-state behaviour on every message.

Note what MRSC does **not** change: both Regions still receive the event and both Lambdas
still run (that duplication is intentional — it is how AWS recommends validating that the
secondary Region works). What is eliminated is the duplicated **side effect**.

#### Claim contention: the loser's path

Once MRSC makes the claim authoritative, exactly one Region wins per event and the other has
to deal with losing. There are three distinct ways that surfaces, and only one of them is
free:

| Situation | What Powertools raises | Result |
|-----------|------------------------|--------|
| Loser arrives **after** the winner flipped the record to `COMPLETED` | `IdempotencyItemAlreadyExistsError` (handled internally) | Clean short-circuit, nothing sent, no error |
| Loser arrives **while** the winner is still sending (record `INPROGRESS`) | `IdempotencyAlreadyInProgressError` | Retried in-process by `runOnce` |
| Loser's claim write races the winner's inside MRSC | `IdempotencyPersistenceLayerError` caused by `ReplicatedWriteConflictException` | Retried in-process by `runOnce` |

**Measured:** the middle row is the dominant path. In steady state the secondary Region hit
`IdempotencyAlreadyInProgressError` on **every** message, while
`ReplicatedWriteConflictException` never fired once. Left unhandled it failed the invocation,
forced an SQS redelivery and kept the `*-lambda-errors` alarm in `ALARM` continuously — no
messages were lost (the redelivery short-circuits cleanly) but the alarm was useless as a
signal.

`runOnce` therefore retries **both** contention cases in-process: 5 attempts with exponential
backoff from 300 ms (~4.5 s total). The budget is sized against the *winner's whole
operation* — it has to finish sending and flip the record to `COMPLETED`, ~2 s here — not
against replication latency. It fits inside both the 30 s Lambda timeout and the 30 s SQS
visibility timeout.

The retry is gated on an `operationStarted` flag so it can only ever fire while the guarded
side effect provably has not run. Powertools uses three distinct wrap messages and only the
`INPROGRESS` claim failure precedes the send. **Do not relax that guard**: retrying after the
send would duplicate it, which is the bug this all exists to fix.

Watch for `Idempotency claim held by another execution, retrying` in the logs; the `reason`
field says which of the two paths fired.

#### ⚠️ Verifying MRSC: an old AWS CLI will lie to you

`aws dynamodb describe-table` **silently omits** `MultiRegionConsistency` and
`GlobalTableWitnesses` if the CLI's bundled service model predates MRSC (GA June 2025). On AWS
CLI 2.17.45 those fields are absent from the model entirely, so the command returns nothing for
them and an MRSC table looks exactly like an eventually consistent one. This cost real
debugging time during rollout — the table was correct and the tool was blind.

Verify with a recent CLI, the console, or an SDK new enough to know the fields (the Lambda
bundle's `@aws-sdk/client-dynamodb` does). A correct table reports:

```
MultiRegionConsistency : STRONG
GlobalTableWitnesses   : [{"RegionName":"us-east-2","WitnessStatus":"ACTIVE"}]
```

#### Costs of MRSC (accepted trade-offs)

- **No TTL.** MRSC does not support TTL, so idempotency records are never physically deleted.
  Correctness is unaffected (see the TTL section above); storage grows — roughly 150 MB per
  million messages, cents per month. If a cleanup job is ever wanted, note there is no index
  on `expiration`, so it would require a full `Scan`; add a date-bucket GSI *before* the table
  grows if that is likely.
- **Write latency.** Writes and strongly consistent reads need cross-region quorum, adding
  tens of milliseconds on the send path.
- **Quorum requirement.** With 3 Regions, quorum is 2 of 3, so a single Region outage still
  accepts writes. Losing two of the three leaves only eventually consistent reads.
- **Failback window.** When a Region that was fully offline comes back, **writes and strongly
  consistent reads in that Region return errors until it catches up**. EventBridge failback is
  driven by `IngestionToInvocationStartLatency` recovery and is *independent* of DynamoDB
  catch-up, so events can be routed back to the primary before its replica is ready; those
  sends fail and retry. Replication covers the message (the secondary still processes it), but
  expect DLQ noise in the recovering Region. AWS does not publish a catch-up duration, and the
  SQS retry budget here is only ~90 s (visibility 30 s × `maxReceiveCount` 3) — worth
  rehearsing in a failover drill rather than assuming.
- **Single-region deployments keep TTL** and skip MRSC entirely: with one Region there is no
  cross-region race to protect against.

Setting `idempotencyWitnessRegion` to empty reverts the table to MREC and **re-opens the
duplicate-send window described above**.

---

## 2. Audit / non-repudiation

### Two levels of "it was sent"

| Level | Source | What it proves | When |
|-------|--------|----------------|------|
| **Acceptance** | `SendEmail`/`Publish` response → `providerMessageId` | AWS **accepted** the message | Synchronous (Lambda knows it) |
| **Delivery** | SES **Configuration Set** (`send`, `delivery`, `bounce`, `complaint`, `reject`) · SNS *delivery status logging* | The message was **delivered** / bounced / rejected / complained | Asynchronous (minutes later) |

For **true non-repudiation** you need **both**. Correlation: inject the `idempotencyKey` as
an SES **message tag** so delivery events carry it back and everything can be joined per
message.

### Archiving pipeline

```
Lambda (after send) ──► ACCEPTANCE (JSON) ──► Firehose ──► [native conversion to Parquet]
                                                           └─► S3 data/dt=YYYY-MM-DD/  (Glue `messages`, projection)
SES Config Set / SNS delivery ──► DELIVERY (JSON) ──► Firehose ──► S3 ses-events/  (Glue `ses_events`, raw JSON)
                                                           └─► Athena queries both tables
```

- **Firehose is regional:** one **per stream, per region**, independent. Under normal
  operation only the **primary** processes. Firehose **batches** by buffer size/interval
  (avoids millions of tiny objects). Formats per stream:
  - **`messages` (acceptance):** native **JSON → Parquet** conversion (OpenX JSON SerDe →
    Parquet SerDe, schema in Glue), columnar and cheap for Athena; buffer ≥ 64 MiB
    (conversion requirement — the code floors `audit.bufferSizeMb` at 64 for this stream
    only, so the YAML value applies to `ses-events` alone); partitioned `dt=YYYY-MM-DD`
    with **partition projection**.
  - **`ses-events` (delivery):** **raw JSON Lines, uncompressed**. Kept as JSON on purpose:
    SES events are nested and polymorphic (`bounce`≠`delivery`, `tags`/`commonHeaders` with
    dynamic keys), and a non-repudiation record must stay **complete**; a strict Parquet
    schema at ingest would silently drop new SES fields. Uncompressed (not GZIP) so the
    forensic records are directly readable — GZIP output adds a `Content-Encoding: gzip`
    header that makes some clients transparently decompress a `.gz`-named file (breaking
    `gzip -d`). Low volume, so the compression saving is negligible.
- **Do NOT feed Firehose from Global Table streams:** replication produces stream records
  in **both** regions → **double counting**. That is why we archive **at send time**, in
  the region that actually sent (one record per real send; a duplicate blocked by dedup is
  not archived).
- **Best-effort on the hot path:** if archiving fails, it is logged but the message is
  **not** re-sent (it already went out). Archiving must never trigger a re-send.

### Immutability (WORM)

The audit bucket uses **S3 Object Lock (WORM)** for strict non-repudiation: records cannot
be altered or deleted during the retention period (365 days) by ordinary operators. It is
enabled in **production only** (`audit.worm`), in **GOVERNANCE mode** — see the rationale
below for why that, and not `COMPLIANCE`. dev/qa capture the same records but the bucket is
not immutable.

WORM (`audit.worm`) and data retention (`retainData`) are **independent** config axes:

| | dev | qa | prod |
|---|:---:|:---:|:---:|
| `audit.worm` (Object Lock + versioning) | ❌ | ❌ | ✅ |
| `audit.wormMode` | — | — | `GOVERNANCE` |
| `audit.objectLockRetentionDays` | — | — | 365 |
| `audit.expirationDays` (deletion) | 0 (never) | 0 (never) | 730 |
| `retainData` (bucket survives teardown) | ❌ | ✅ | ✅ |

Leaving both off in dev is intentional: it is a throwaway environment under constant
iteration, and immutable objects cannot be deleted for a year — which would make every
teardown leave a permanent bucket behind. Object Lock is a **create-time** bucket property
and requires versioning, so flipping `audit.worm` on an existing bucket requires replacing
it.

**Why prod ships `GOVERNANCE` and not `COMPLIANCE`.** Both make the trail immutable in
practice. The difference is the escape hatch: under `GOVERNANCE` a principal holding
`s3:BypassGovernanceRetention` can delete an object, under `COMPLIANCE` nobody can — not even
the account root — until retention expires. Since the SES delivery events contain the
recipient address in clear text, `COMPLIANCE` would make that personal data undeletable for a
full year, which cannot be reconciled with a data-subject erasure request. `GOVERNANCE` keeps
that path open while still preventing accidental or casual deletion. Choose `COMPLIANCE` only
when a regulator explicitly requires it and you have accepted the consequence — see
[`compliance.md`](./compliance.md).

The retention combination is validated at **synth time**: an expiry inside the Object Lock
window, or one that precedes the archive transition, fails with an explanatory error instead
of being silently rejected by S3 later.

### Audited fields

`idempotencyKey`, `product`, `channel`, `feature`, `language`, **hashed recipient** (PII
minimization), `status`, `providerMessageId`, `region`, `timestamp`.

> `status` is **`ACCEPTED` or `FAILED` only**. The acceptance record is written once, at send
> time, and never updated — so delivery outcomes (`Delivery`/`Bounce`/`Complaint`/`Reject`)
> are **not** in this field. They live in `ses_events.eventType` and are joined on
> `idempotencyKey`; see the query below.

---

## Querying the trail (Athena)

Two Glue tables in the `${prefix_with_underscores}_audit` database:

| Table | Format | Columns |
|-------|--------|---------|
| `messages` | Parquet, partitioned by `dt` | the 10 acceptance fields above |
| `ses_events` | raw JSON | `eventType`, plus projections of `mail`, `delivery`, `bounce`, `complaint`, `reject` |

**`ses_events` projects only what is needed to correlate and to establish the outcome.**
Clear-text recipient fields (`mail.destination`, `delivery.recipients`,
`bouncedRecipients[].emailAddress`, `mail.headers`) are intentionally **not** declared, so the
query layer stays PII-minimized — they remain present in the S3 object (see
[`compliance.md`](./compliance.md#pii-in-the-ses-delivery-events)). The OpenX JSON SerDe
ignores undeclared fields, so nothing is lost at ingest and new SES fields can be exposed
later by adding columns.

> ### ⚠️ Map keys are lower-cased
> The OpenX JSON SerDe lower-cases keys, so the SES message tag must be read as
> **`mail.tags['idempotencykey']`** — `mail.tags['idempotencyKey']` silently returns `NULL`.
> Tag values are arrays, so index the first element (Athena arrays are **1-based**).

### Acceptance → delivery outcome, per message

This is the non-repudiation report: what we accepted, and what the provider actually did
with it.

```sql
WITH ev AS (
    SELECT mail.tags['idempotencykey'][1] AS k,
           eventtype,
           delivery.smtpresponse AS smtp,
           bounce.bouncetype     AS btype,
           bounce.bouncedrecipients[1].diagnosticcode AS diag
    FROM ses_events
)
SELECT m.dt,
       m.idempotencykey,
       m.status AS accepted,
       m.recipienthash,
       max(CASE WHEN ev.eventtype = 'Delivery' THEN 'DELIVERED'
                WHEN ev.eventtype = 'Bounce'   THEN 'BOUNCED' END) AS outcome,
       max(coalesce(ev.smtp, ev.diag)) AS provider_response,
       max(ev.btype) AS bounce_type
FROM messages m
LEFT JOIN ev ON ev.k = m.idempotencykey
GROUP BY m.dt, m.idempotencykey, m.status, m.recipienthash
ORDER BY m.dt, m.idempotencykey;
```

Verified live output (see [`e2e-evidence.md`](./e2e-evidence.md)) — note the row where SES
accepted the message but the provider bounced it, which is precisely the case synchronous
acceptance alone cannot detect:

| idempotencykey | accepted | outcome | provider_response | bounce_type |
|---|---|---|---|---|
| `e2e-t1` | ACCEPTED | DELIVERED | `250 2.0.0 OK … DMARC:Quarantine` | |
| `e2e-gz-check-1` | ACCEPTED | **BOUNCED** | `smtp; 550-5.7.1 … Gmail ha…` | `Transient` |
| `cert-20260902-t1-es` | ACCEPTED | DELIVERED | `250 2.0.0 OK … DMARC:Quarantine` | |

Restrict by partition (`WHERE m.dt = '2026-09-02'`) to keep scans small — the `messages`
table uses partition projection, so a single-day query scans on the order of 1 KB.

### Global view and retention

- **Default:** one audit bucket **per region** + **Athena** unifying by the `region`
  partition (simple, no replication cost).
- **Optional (CRR):** if compliance requires a **single central immutable bucket**,
  replicate secondary → central with **S3 Cross-Region Replication**.
- **Retention:** via **S3 lifecycle** (e.g. transition to Glacier after N days), not a
  cron. This is where the configurable lifecycle rule lives.

---

## CRR: audit vs templates (don't conflate)

Same mechanism (S3 CRR), **different purpose and direction**, and optional in both cases:

| | Templates (config) | Audit (generated data) |
|---|---|---|
| What it is | Static content the consumer **reads** per region | Records generated at runtime |
| Direction | primary → secondary (push config) | secondary → central (consolidate) |
| CRR required? | No: can be **uploaded at deploy** to both buckets | No: default per-region bucket + Athena |

Reminders: **S3 bucket names are global** → the **region must be in the name** in
multi-region; **CRR requires versioning** on source and destination.

---

## Estimated cost (1M messages/month)

| Component | Approx |
|-----------|--------|
| DynamoDB dedup writes (~2/msg, on-demand) | ~$2.5/mo |
| DynamoDB storage — single-region (TTL prunes it) | cents |
| DynamoDB storage — multi-region MRSC (**no TTL**, grows ~150 MB/M messages) | cents/mo, cumulative |
| Firehose (~300 MB/mo) | ~$0.01/mo |
| S3 audit storage (Parquet/JSON compressed) | cents |

Data growth is **not a cost or performance problem** for DynamoDB: access is by partition key,
so latency stays constant however large the table gets. Single-region, TTL also caps the size;
under MRSC it does not, so the table grows indefinitely at a few cents a month. The value is in
**correctness** (no duplicates) and **evidence** (non-repudiation).

---

## Implementation status by phase

| Phase | Scope | Status |
|-------|-------|:------:|
| **0** | `idempotencyKey` contract (Zod) + DynamoDB table + Powertools Idempotency (INPROGRESS/COMPLETED) + per-template TTL | ✅ |
| **0.1** | Synchronous **acceptance** record (`providerMessageId`) → Firehose → S3 **Parquet** (native conversion, partition projection) + Glue/Athena | ✅ |
| **0.2** | Asynchronous **delivery**: SES Configuration Set + SNS delivery logging → audit, correlated by `idempotencyKey`, joinable in Athena | ✅ |
| **0.3** | **Object Lock (WORM)** + lifecycle retention on the audit bucket | ✅ |
| **1** | Multi-region: Global Table, region-scoped bucket name, EventBridge Global Endpoint + health check + replication | ✅ (opt-in `secondaryRegion`) |
| — | Bounce suppression list, CRR to central bucket, CloudWatch dashboard, (optional) Parquet for `ses_events` | 🔜 |

See [`compliance.md`](./compliance.md) for the associated compliance posture.
