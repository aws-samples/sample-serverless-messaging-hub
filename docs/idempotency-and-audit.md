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
  - TTL enabled on `expiration`
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

### Per-template TTL (default 1 day)

- The template configuration item (`templates` table) carries `idempotencyTtlSeconds`; if
  absent, **default 86400 (1 day)**.
- It is read **before** the guard (a side-effect-free read) and used as the `COMPLETED`
  record expiry.
- DynamoDB **TTL deletes expired records for free** (no delete WCU, no scans): the table
  does not grow unbounded. The real cost is writes (~2 per message), not storage.

### Multi-region

- In multi-region the table is promoted to a **DynamoDB Global Table** (region-agnostic
  name). A write in region A replicates to B.
- **Residual risk (documented):** Global Tables are **eventually consistent** (typical lag
  <1s). During an overlapping failover, the secondary might not yet see the primary's
  record → **small chance of a duplicate**. This is inherent to the active-active model;
  strong cross-region consistency is not viable without sacrificing the availability we
  seek.

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
be altered or deleted during the retention period (365 days). It is enabled in **production
only** (`audit.worm`) in **COMPLIANCE mode** (not even root can override). dev/qa capture
the same records but the bucket is not immutable.

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
| DynamoDB storage (with TTL, steady state) | cents |
| Firehose (~300 MB/mo) | ~$0.01/mo |
| S3 audit storage (Parquet/JSON compressed) | cents |

Data growth is **not a cost or performance problem** for DynamoDB (PK access = constant
latency; TTL caps the size). The value is in **correctness** (no duplicates) and
**evidence** (non-repudiation).

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
