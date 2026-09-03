# End-to-end test evidence — Messaging Hub

Live validation of the deployed **multi-region** stack.

- **Account:** 590183859692
- **Regions:** primary `us-east-1`, secondary `us-west-2`
- **Global Endpoint:** `acme-dev-messaging-hub-endpoint` — EndpointId `k9fdqerv7o.veo` (State `ACTIVE`, replication `ENABLED`)
- **Run date (UTC):** 2026-09-02
- **Purpose:** certify the observability + least-privilege changes (managed log groups with
  retention, X-Ray active tracing, ARN-scoped SES policy) and confirm no regression in the
  previously validated behaviour.

## Deployment state

| Stack | Region | Status |
|-------|--------|--------|
| `dev-architecture-messaging-hub` | us-east-1 | UPDATE_COMPLETE |
| `dev-architecture-messaging-hub-us-west-2` | us-west-2 | UPDATE_COMPLETE |
| `dev-global-endpoint-messaging-hub` | us-east-1 | no changes |

`cdk diff --all -c env=dev` after deploying: **0 differences across 15 stacks**. The later
move of observability/alarm/failover values into the environment YAML also produced **0
differences**, proving that refactor is behaviour-preserving.

> **One-time migration performed:** Lambda had auto-created
> `/aws/lambda/acme-dev-messaging-hub-send-{email,sms}` outside CloudFormation. Those 3
> orphan groups (2 in us-east-1, 1 in us-west-2) were deleted before deploying, otherwise
> CloudFormation fails with `already exists`. They are now stack-managed.

## Pre-flight

| Check | Result |
|-------|--------|
| SES identities (us-east-1) | `hdomingy@amazon.com` + `hdomingy@gmail.com`, both verified, sending enabled (account still in **sandbox**) |
| DynamoDB seed | 2 records (`email#welcome#en`, `email#welcome#es`) with `templatePath` + `idempotencyTtlSeconds=86400` |
| HTML templates in S3 | `demo/en/welcome.html`, `demo/es/welcome.html` in **both** region buckets |
| SNS alarm subscription | confirmed (not `PendingConfirmation`) |
| Queues | all 4 empty in both regions |
| Idempotency table | **empty** — the previous run's records expired via TTL, so this run started from a clean baseline |

## Test matrix

Events published to the primary bus `acme-dev-messaging-hub-messages-bus` (T1–T4) and to the
**Global Endpoint** (T5).

> "Email sent" below means **SES accepted** the message (SendEmail success +
> `providerMessageId`). The independent delivery outcome is in
> [Delivery outcome](#delivery-outcome).

| # | Scenario | Input | Expected | Result | Evidence |
|---|----------|-------|----------|--------|----------|
| T1 | Happy path (ES) | `cert-20260902-t1-es`, `welcome/es` | Email sent | ✅ | `Email sent successfully` @14:20:52.671Z, `providerMessageId 010001a0627e7fc4-…` |
| T2 | Happy path (EN) | `cert-20260902-t2-en`, `welcome/en` | Email sent | ✅ | `Email sent successfully` @14:20:52.628Z, `providerMessageId 010001a0627e7f54-…` |
| T3 | Idempotency / duplicate | Re-publish T1 (same key) | NOT re-sent | ✅ | `t1-es` **processed 2×**, **sent 1×**; idempotency table = 3 items (not 4) |
| T4 | Validation failure | Event **without** `idempotencyKey` | Rejected → DLQ | ✅ | 3 × `ERROR-01: detail.idempotencyKey: Required` @14:22:00 / 14:22:29 / 14:22:59 (30s apart = visibility timeout) → **email DLQ depth 1** |
| T5 | Real Global Endpoint publish | `PutEvents --endpoint-id k9fdqerv7o.veo` | Accepted + sent once | ✅ | `FailedEntryCount=0`, EventId `ec02b2bf-127a-7c31-0c38-319f08990baa`; sent @14:22:22.605Z |

### T5 — Global Endpoint (SigV4A)

Publishing to a Global Endpoint requires **SigV4A** multi-region signing. The previous run
needed `pip install 'botocore[crt]' awscrt`; **AWS CLI v2.17.45 bundles `awscrt`**, so this
now works with no extra install:

```bash
aws events put-events --region us-east-1 --endpoint-id k9fdqerv7o.veo --entries file://event.json
# → { "FailedEntryCount": 0, "Entries": [{ "EventId": "ec02b2bf-127a-7c31-0c38-319f08990baa" }] }
```

## Idempotency — including cross-region

Primary: `t1-es` shows **2 "Processing email"** entries but only **1 "Email sent
successfully"**. The duplicate reached the handler and was short-circuited by the guard.

The **secondary region** produced the strongest evidence. Because the Global Endpoint
replicates, T5 was delivered to us-west-2 as well:

| Observation | Value |
|-------------|-------|
| Emails sent by the secondary | **0** |
| Keys processed by the secondary | `cert-20260902-t5-endpoint` ×2 |
| Error raised | `IdempotencyAlreadyInProgressError` |
| Secondary DLQ depth | 0 |

That is the documented `INPROGRESS → COMPLETED` guard working **across regions**: the
secondary saw the primary's `INPROGRESS` record through the DynamoDB Global Table, refused
to send, returned the message to the queue, and on retry found `COMPLETED` and
short-circuited cleanly. Net result: exactly one send, no DLQ.

Idempotency table contents — identical in **both** regions (Global Table replication):
3 items, all `COMPLETED`, one per unique key.

Note T1–T4 were **not** replicated: they were published straight to the primary bus, and a
bus does not replicate. Only events published to the Global Endpoint fan out to both regions.

## Audit / non-repudiation

**Acceptance (Parquet):**
```
s3://acme-dev-messaging-hub-audit-us-east-1/data/dt=2026-09-02/
  acme-dev-messaging-hub-audit-1-2026-09-02-14-20-52-….parquet   (2 432 bytes)
```

Queried with **Athena** (`messages` table, partition projection):

| idempotencykey | status | region | recipienthash |
|---|---|---|---|
| cert-20260902-t2-en | ACCEPTED | us-east-1 | `0c2ea21e…79e9de` |
| cert-20260902-t1-es | ACCEPTED | us-east-1 | `0c2ea21e…79e9de` |
| cert-20260902-t5-endpoint | ACCEPTED | us-east-1 | `0c2ea21e…79e9de` |

Only **981 bytes scanned** — Parquet + partition projection working as designed. The
recipient is stored as a SHA-256 hash (identical across rows because it is the same
recipient), never in clear text. The secondary region wrote **no** acceptance record for
this run, consistent with it never sending.

**SES delivery events (raw JSON):** `ses-events/2026/09/02/…` (8 622 bytes), **uncompressed
and directly readable** — the documented "no GZIP" decision holds (the older `.gz` objects
predate it). Athena over `ses_events` across both runs: `Send 7`, `Delivery 6`, `Bounce 1`.

### Non-repudiation bucket — read and verified directly

Bucket posture (`acme-dev-messaging-hub-audit-us-east-1`, dev):

| Control | State |
|---------|-------|
| Encryption | SSE-S3 (`AES256`) |
| Public access | all four blocks `true` |
| Object Lock | not configured — correct for dev (`audit.worm: false`) |
| Versioning | off — correct for dev (versioning is only enabled with WORM) |
| Lifecycle | `to-glacier`, transition at 90 days |
| Contents | 4 Parquet acceptance objects + 4 SES-event objects |

**Acceptance records — all 10 documented fields populated**, across all 7 messages of both
runs. Sample (`SELECT` of every column):

| dt | idempotencykey | product | channel | feature | language | status | region |
|---|---|---|---|---|---|---|---|
| 2026-09-02 | cert-20260902-t1-es | demo | email | welcome | es | ACCEPTED | us-east-1 |
| 2026-09-02 | cert-20260902-t2-en | demo | email | welcome | en | ACCEPTED | us-east-1 |
| 2026-09-02 | cert-20260902-t5-endpoint | demo | email | welcome | es | ACCEPTED | us-east-1 |

Plus `recipienthash` (SHA-256, never clear text), `providermessageid` and `timestamp` on
every row.

#### Defect found and fixed: `ses_events` was effectively unqueryable

The Glue table for `ses_events` declared **one** column (`eventType`). The S3 objects contain
~29 field paths per delivery record, but Athena could only count event types —
`mail.messageId`, `mail.tags['idempotencyKey']`, `delivery.smtpResponse` and
`bounce.bounceType` all failed with `COLUMN_NOT_FOUND`. The documented "correlated by
`idempotencyKey`, queryable with Athena" claim therefore did not hold through SQL, even though
the data was intact in S3.

Fixed by projecting the correlation and outcome structs (clear-text recipient fields
deliberately left unprojected — see
[`compliance.md`](./compliance.md#pii-in-the-ses-delivery-events)), deployed to both regions.
The acceptance-to-outcome join now works; see
[`idempotency-and-audit.md`](./idempotency-and-audit.md#querying-the-trail-athena) for the
query and its live output. A second gotcha surfaced while verifying: the OpenX JSON SerDe
lower-cases map keys, so the tag must be read as `mail.tags['idempotencykey']`.

#### Saved Athena queries — delivery visibility verified

Two `AWS::Athena::NamedQuery` resources are deployed per region. Both were fetched from
Athena and executed **verbatim as deployed**:

| Saved query | Rows | Result |
|-------------|-----:|--------|
| `acme-dev-messaging-hub-delivery-outcome` | 7 | Every message of both runs resolved: **6 DELIVERED, 1 BOUNCED**, each with `providerMessageId`, hashed recipient and the provider response |
| `acme-dev-messaging-hub-delivery-problems` | 7 | Caught the 1 hard bounce **plus the 6 messages silently quarantined as spam** (`250 OK … DMARC:Quarantine`) |

The second query is the one that matters operationally: a spam-filtered message reports
`Delivery` with `250 OK`, so counting bounces alone would report 100% success while six
messages sat in a spam folder.

Confirmed present in **both** regions (`us-east-1`, `us-west-2`).

#### Configurable retention verified

Lifecycle rule `audit-retention` deployed in both regions: transition to `GLACIER` at 90
days, **no expiration** (dev ships `expirationDays: 0`), Object Lock **not configured**
(dev ships `worm: false`). Every one of these is now a YAML value — `worm`, `wormMode`,
`objectLockRetentionDays`, `glacierTransitionDays`, `glacierStorageClass`, `expirationDays` —
and impossible combinations are rejected at synth. Prod ships `GOVERNANCE` + 730-day expiry so
a data-erasure path stays open; see
[`compliance.md`](./compliance.md#-pii-in-the-ses-delivery-events).

### Delivery outcome

Every message from this run carries both a `Send` and a `Delivery` event, correlated by the
`idempotencyKey` message tag:

| eventType | idempotencyKey | SMTP response |
|-----------|----------------|---------------|
| Send + Delivery | `cert-20260902-t1-es` | `250 2.0.0 OK … DMARC:Quarantine` |
| Send + Delivery | `cert-20260902-t2-en` | `250 2.0.0 OK … DMARC:Quarantine` |
| Send + Delivery | `cert-20260902-t5-endpoint` | `250 2.0.0 OK … DMARC:Quarantine` |

**Improvement over the previous run**, which recorded a `Bounce`
(`550-5.7.1 … UnsolicitedMessageError`, Gmail spam block). Gmail now **accepted** all three
(`250 OK`), though `DMARC:Quarantine` means they are likely quarantined rather than in the
inbox — expected for a bare email-address SES identity with no domain-aligned DKIM/SPF/DMARC.
Verifying a sending **domain** remains the fix for true inbox placement.

This is exactly the value of the asynchronous audit trail: it records the real per-recipient
outcome that synchronous acceptance cannot see.

## Monitoring / alerting

| Alarm | Region | Transition |
|-------|--------|-----------|
| `email-lambda-errors` | us-east-1 | OK → ALARM @14:23:38 (T4's 3 failures) |
| `email-dlq-not-empty` | us-east-1 | OK → ALARM @14:26:39 → **ALARM → OK @14:33:39** after draining |
| `email-lambda-errors` | us-west-2 | OK → ALARM @14:23:46 (the `IdempotencyAlreadyInProgressError` from replicated T5) |

The DLQ alarm exercised the **full lifecycle** (fire and clear), confirming both the ALARM
and OK notification paths. Alarm inventory matches the synthesized prediction exactly: **9
in us-east-1** (8 + the Global Endpoint latency alarm) and **8 in us-west-2** = 17.

## Newly certified capabilities

These are the changes this run set out to prove.

**1. ARN-scoped SES policy did not break sending.** The email Lambda's policy went from
`Resource: "*"` to `identity/*` + `configuration-set/*` in the deploying account/region.
All four sends succeeded, so the tightened scope is sufficient for `SendEmail` with a
configuration set. This was the main regression risk.

**2. Managed log groups with retention.** All application logs for this run landed in the
CloudFormation-managed groups `/aws/lambda/acme-dev-messaging-hub-send-{email,sms}` with
`retentionInDays: 90`, in both regions. Previously these were implicit, unmanaged groups
with no expiry.

**3. X-Ray active tracing — now producing real traces.** The `REPORT` lines carry
`XRAY TraceId: … Sampled: true`, and Powertools log entries now include `xray_trace_id`;
neither existed before, since `Tracing` was never set to `ACTIVE`. **39 spans across 7 trace
IDs** were recorded for the email function, matching the 7 invocations of this run
(T1, T2, T3-duplicate, T4 ×3, T5). The span names confirm the Powertools instrumentation is
genuinely emitting:

| Span | Source |
|------|--------|
| `…-send-email/LambdaService` | Lambda service segment |
| `…-send-email/LambdaExecutionEnvironment` | execution environment segment |
| `## index.handler` | Powertools `captureLambdaHandler` middleware |
| `### send` | `@tracer.captureMethod()` on `SendEmailService.send` |

> **Where the traces live.** This account has **X-Ray Transaction Search** enabled
> (`GetTraceSegmentDestination` → `Destination: CloudWatchLogs`, `ACTIVE`), so segments are
> written to the `aws/spans` CloudWatch log group instead of the classic X-Ray trace store.
> `GetTraceSummaries` / `BatchGetTraces` therefore return **0** results even though tracing
> works — query `aws/spans` (or the CloudWatch Transaction Search console) instead. This is
> an account-level setting, not a property of this stack. The account indexing rule is
> probabilistic at **1%**, so only a fraction of spans are searchable by trace attributes
> while all spans are retained in the log group.

## Cleanup performed

- Email DLQ purged (the captured T4 message had no `idempotencyKey`, `receiveCount 4`), which
  returned the DLQ alarm to OK.
- Athena temporary result objects removed; the templates bucket is back to exactly its 2
  HTML objects.
- All queues empty in both regions at end of run.

## Summary

| Capability | Verified |
|------------|:--------:|
| Event routing → SQS → Lambda → SES accepted (`providerMessageId`) | ✅ |
| Handlebars template render (es/en) | ✅ |
| Idempotency / exactly-once (duplicate suppressed) | ✅ |
| **Cross-region idempotency** (secondary refused to double-send) | ✅ |
| Validation failure → 3 retries → DLQ | ✅ |
| Audit acceptance → Parquet in S3, queried via Athena (981 B scanned) | ✅ |
| All 10 acceptance fields populated, recipient hashed (SHA-256) | ✅ |
| Async delivery audit correlated by `idempotencyKey` tag | ✅ after fixing the `ses_events` Glue schema |
| Acceptance ↔ delivery-outcome join in Athena | ✅ |
| Clear-text recipient not reachable through the query layer | ✅ |
| Clear-text PII inside the raw SES event objects | ⚠️ by design — unresolved for prod WORM, see compliance.md |
| SES delivery outcome (`250 OK`, DMARC quarantine) | ✅ |
| DynamoDB Global Table replication (both regions identical) | ✅ |
| CloudWatch alarms → SNS, full ALARM→OK lifecycle | ✅ |
| Global Endpoint ACTIVE, replication enabled, real SigV4A publish | ✅ |
| **ARN-scoped SES policy (no send regression)** | ✅ |
| **Managed log groups, 3-month retention, both regions** | ✅ |
| **X-Ray active tracing emitting Powertools spans** | ✅ |
| Inbox placement at Gmail | ⚠️ delivered but DMARC-quarantined — needs a verified sending domain |
