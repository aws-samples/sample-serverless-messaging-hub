# Cost review — Messaging Hub

Architecture-level cost estimate for the **multi-region** deployment.

> ⚠️ These are **order-of-magnitude estimates** with the assumptions below (Node 22 /
> arm64 128 MB, ~300 ms/invocation, on-demand pricing, `us-east-1`; `us-west-2` similar).
> For a contractual figure use the **[AWS Pricing Calculator](https://calculator.aws/)** —
> real prices vary by region and over time. SNS/SMS is intentionally excluded (see below).

## Scenario & assumptions

- **1,000,000 emails / month.**
- Multi-region: primary + secondary, **event replication ENABLED** (our config), so **both
  regions process** the events.
- **Idempotency (DynamoDB Global Table) ensures only ONE real SES send**: the secondary
  region's Lambda short-circuits on the dedup guard and does **not** call SES.
- SNS/SMS excluded (country-dependent).

## Monthly estimate (USD)

| Service | Primary | Secondary | ~Total | Notes |
|---|---:|---:|---:|---|
| **SES (sending)** | ~$100 | ~$0 | **~$100** | $0.10 / 1,000 emails. Secondary does not send (idempotency) |
| Lambda (email) | ~$0.70 | ~$0.45 | ~$1.15 | $0.20/M requests + arm64 compute; secondary runs shorter |
| SQS | ~$1.50 | ~$1.50 | ~$3.00 | ~3 req/message + polling; $0.40/M |
| EventBridge | ~$1.00 | ~$1.00 | ~$2.00 | $1/M custom events; replication duplicates |
| DynamoDB (Global Table) | — | — | ~$8–12 | ~2 writes/msg + replica (rWCU) + reads; storage tiny via TTL |
| Firehose (Parquet) | ~$0.30 | ~$0 | ~$0.30 | $0.029/GB + $0.018/GB conversion; **5 KB/record billing rounding** |
| S3 audit storage | ~$0.50 | ~$0 | ~$0.50 | Parquet (acceptance) + plain JSON (ses-events); WORM prod only |
| Glue Data Catalog | — | — | ~$0 | within free tier at this volume |
| CloudWatch Logs | ~$3 | ~$2 | ~$5 | assumes `observability.logEvent: true` (dev/qa); prod ships `false` and costs less |
| CloudWatch Alarms | ~$0.80 | ~$0.80 | ~$1.70 | 8/region + endpoint alarm = 17 in multi-region; $0.10 each |
| X-Ray (tracing) | ~$5 | ~$5 | ~$10 | $5/M traces; active tracing is **on**, at the X-Ray default sampling — see levers |
| Route 53 health check | — | — | ~$0.50 | health check over a CloudWatch alarm |
| Cross-region data transfer | — | — | ~$1 | event replication + DynamoDB |
| **TOTAL** | | | **~$135/mo** | |

## Idle vs load

This ~$135/mo is the cost **at 1M emails/month of throughput**, not a standing cost. The
architecture is fully serverless / pay-per-use, so **at idle (zero traffic) it drops to
≈ $2/month**:

- **$0 at idle** (pay-per-use): Lambda, SQS, EventBridge, SES ($0.10 × emails sent), Firehose,
  DynamoDB on-demand, Athena.
- **Fixed monthly charges regardless of traffic:** CloudWatch alarms ($0.10 each → ~$1.70
  multi-region) + Route 53 health check (~$0.50). Storage (S3/DynamoDB/Logs) is cents with
  empty tables + TTL.
- **No** NAT, VPC, KMS CMK, provisioned concurrency, or any per-hour resource.

In other words: of the ~$135, **~$100 is SES** (exactly the emails you send) and the rest
scales with usage; turn off the traffic and you pay ~$2/month.

## Reading the result

- **SES dominates: ~$100 (≈74%).** Everything else combined ≈ **$35/mo**.
- **Multi-region overhead** (vs single region) is only ~**$15–20/mo**: duplicated
  compute / SQS / logs / X-Ray + event replication + Global Table + health check. **SES
  does not change** (still 1M sends thanks to idempotency).
- **Idempotency pays for its infrastructure:** without it, with replication enabled you
  would send **2M emails → ~$200 SES**. Dedup saves ~$100/mo and prevents duplicate
  messages to the user.

## Cost levers

1. **X-Ray sampling**: active tracing is enabled with no explicit sampling rule, so it uses
   the X-Ray default (1 req/s per host plus 5% of the remainder). Adding an explicit rule at
   5–10% takes this line from ~$10 to ~$1 at volume.
2. **Full-event logging** (`observability.logEvent`): **already off in prod** — the shipped
   `env-prod.yml` sets it to `false`, since logging every event body dominates the
   CloudWatch bill ($/GB ingested). dev/qa keep it on for debuggability. Log groups also
   expire at `observability.logRetentionDays` (3 months), which bounds *stored* volume but
   not *ingestion*, the bigger charge. The estimate above assumes it is **on**, so prod runs
   below the CloudWatch Logs line shown.
3. **Event replication**: disabling it leaves the secondary as *cold standby* (ingestion
   only), saving ~$15/mo of duplicated compute/logs/X-Ray — **but you lose automatic
   recovery after failover** and the "warm" validation of the secondary region. Resilience
   vs cost trade-off.
4. **Athena**: not a fixed cost — $5/TB **scanned**. With Parquet + partition projection,
   queries scan very little.

## SNS / SMS (not calculated)

SMS is billed **per message and varies widely by country** (e.g. US ~$0.006–0.01, other
countries 10–20×). At 1M SMS the range spans from hundreds to thousands of dollars
depending on destination. Also: the account currently has **`MonthlySpendLimit=$1`** and
is likely in the SMS sandbox — the limit must be raised and sandbox exited before any
volume. Size it with the AWS Pricing Calculator per destination country.

## Reference prices used (approx, us-east-1, on-demand)

| Item | Price |
|------|-------|
| SES outbound | $0.10 / 1,000 emails |
| Lambda requests | $0.20 / 1M |
| Lambda compute (arm64) | $0.0000133334 / GB-s |
| EventBridge custom events | $1.00 / 1M |
| SQS requests | $0.40 / 1M |
| DynamoDB on-demand write | $1.25 / 1M WRU |
| DynamoDB replicated write (Global Table) | ~$1.875 / 1M rWCU |
| Firehose ingestion | $0.029 / GB (5 KB min per record) |
| Firehose format conversion | $0.018 / GB |
| S3 Standard storage | $0.023 / GB-mo |
| CloudWatch Logs ingestion | $0.50 / GB |
| CloudWatch alarm | $0.10 / alarm-mo |
| X-Ray traces | $5.00 / 1M |
| Athena | $5.00 / TB scanned |

Always confirm with the **[AWS Pricing Calculator](https://calculator.aws/)** for your
regions and volumes.
