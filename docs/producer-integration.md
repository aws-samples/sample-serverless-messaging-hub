# Producer integration — publishing to the Messaging Hub

For teams that want to **send** notifications. You publish one event; the hub resolves the
template, renders it and delivers by email or SMS. You never touch SES, SNS or the templates.

- **Single-region deployment** (`secondaryRegion` empty): publish to the **event bus**.
- **Multi-region deployment** (`secondaryRegion` set): publish to the **Global Endpoint** so
  events keep flowing if the primary Region degrades.

Everything below assumes the multi-region case, which has extra requirements. The
single-region call is the same minus `EndpointId`.

---

## 1. What you need before writing code

| # | Requirement | Notes |
|---|-------------|-------|
| 1 | The **`EndpointId`** | Not the bus name. See [how to get it](#2-get-the-endpointid) |
| 2 | The **bus name** | Required *in addition to* `EndpointId` — see [gotchas](#5-gotchas-that-will-cost-you-an-afternoon) |
| 3 | **`events:PutEvents`** on the bus ARN in **both** Regions | [IAM policy](#4-iam-policy-for-the-producer) |
| 4 | The **AWS CRT** library for your SDK | Global endpoints sign with **SigV4A**, which is not in the base SDK |
| 5 | **Regional** STS credentials | Credentials from the *global* STS endpoint do not support SigV4A |
| 6 | A stable **`idempotencyKey`** per logical message | You generate it; it drives exactly-once delivery |

### Why the CRT is needed

A global endpoint can route a single request to either Region, so it is signed with
**Signature Version 4A** (multi-Region signing) instead of plain SigV4. That algorithm lives
in the AWS Common Runtime, shipped as a separate package. Without it you get:

```
Python : MissingDependencyException: Missing Dependency: This operation requires an
         additional dependency. Use pip install botocore[crt] before proceeding.
Node.js : ... check whether you have installed the "@aws-sdk/signature-v4-crt" package
Java    : you must include auth-crt on the class path
```

Once installed, signing is automatic — you keep supplying credentials the usual way.

---

## 2. Get the `EndpointId`

The `EndpointId` is the **subdomain** of the endpoint URL, not the endpoint name. For
`https://abcde.veo.endpoints.event.amazonaws.com` the `EndpointId` is `abcde.veo`.

```bash
aws events describe-endpoint \
  --name <organization>-<env>-<appName>-endpoint \
  --region <primaryRegion> \
  --query '{EndpointId:EndpointId,State:State,Buses:EventBuses}'
```

```json
{
  "EndpointId": "k9fdqerv7o.veo",
  "State": "ACTIVE",
  "Buses": [
    { "EventBusArn": "arn:aws:events:us-east-1:<account>:event-bus/<prefix>-messages-bus" },
    { "EventBusArn": "arn:aws:events:us-west-2:<account>:event-bus/<prefix>-messages-bus" }
  ]
}
```

Treat it as configuration (env var / Parameter Store), not a hardcoded constant — it changes
if the endpoint is recreated.

---

## 3. Code

### Python

```bash
pip install boto3 awscrt          # awscrt is what enables SigV4A
```

```python
import json
import os
import uuid
import boto3
from botocore.config import Config

# Regional STS endpoint: credentials from the GLOBAL endpoint cannot sign SigV4A.
session = boto3.Session()
events = session.client(
    "events",
    region_name=os.environ["AWS_REGION"],
    config=Config(
        sts_regional_endpoints="regional",
        retries={"max_attempts": 5, "mode": "adaptive"},  # see gotcha #4
    ),
)

ENDPOINT_ID = os.environ["MESSAGING_ENDPOINT_ID"]   # e.g. "k9fdqerv7o.veo"
BUS_NAME = os.environ["MESSAGING_BUS_NAME"]         # e.g. "acme-dev-messaging-hub-messages-bus"


def send_welcome_email(order_id: str, recipient: str, name: str) -> str:
    # Stable and unique per logical message. Reuse it on retries so the hub
    # deduplicates instead of sending twice.
    idempotency_key = f"welcome-{order_id}"

    response = events.put_events(
        EndpointId=ENDPOINT_ID,
        Entries=[
            {
                "EventBusName": BUS_NAME,      # required even with EndpointId
                "Source": "eventbridge.messages",
                "DetailType": "email",         # "email" or "sms"
                "Detail": json.dumps(
                    {
                        "idempotencyKey": idempotency_key,
                        "product": "demo",     # DynamoDB partition key
                        "channel": "email",
                        "feature": "welcome",
                        "language": "es",
                        "mail": recipient,     # string or list of strings
                        "name": name,          # any extra key -> Handlebars {{name}}
                    }
                ),
            }
        ],
    )

    # PutEvents returns 200 even when individual entries fail. ALWAYS check this.
    if response["FailedEntryCount"] > 0:
        raise RuntimeError(f"publish failed: {response['Entries']}")

    return response["Entries"][0]["EventId"]
```

### TypeScript

```bash
npm install @aws-sdk/client-eventbridge @aws-sdk/signature-v4-crt
```

```ts
// The CRT package must be IMPORTED to register itself, not merely installed.
import '@aws-sdk/signature-v4-crt';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const client = new EventBridgeClient({
  region: process.env.AWS_REGION,
  maxAttempts: 5, // see gotcha #4
});

const ENDPOINT_ID = process.env.MESSAGING_ENDPOINT_ID!; // e.g. "k9fdqerv7o.veo"
const BUS_NAME = process.env.MESSAGING_BUS_NAME!;

export async function sendWelcomeEmail(
  orderId: string,
  recipient: string,
  name: string,
): Promise<string> {
  // Stable and unique per logical message. Reuse it on retries.
  const idempotencyKey = `welcome-${orderId}`;

  const response = await client.send(
    new PutEventsCommand({
      EndpointId: ENDPOINT_ID,
      Entries: [
        {
          EventBusName: BUS_NAME, // required even with EndpointId
          Source: 'eventbridge.messages',
          DetailType: 'email', // 'email' or 'sms'
          Detail: JSON.stringify({
            idempotencyKey,
            product: 'demo', // DynamoDB partition key
            channel: 'email',
            feature: 'welcome',
            language: 'es',
            mail: recipient, // string or string[]
            name, // any extra key -> Handlebars {{name}}
          }),
        },
      ],
    }),
  );

  // PutEvents resolves successfully even when individual entries fail. ALWAYS check.
  if ((response.FailedEntryCount ?? 0) > 0) {
    throw new Error(`publish failed: ${JSON.stringify(response.Entries)}`);
  }

  return response.Entries![0].EventId!;
}
```

> `@aws-sdk/signature-v4-crt` contains a native module and is **Node.js only** — it will not
> run in a browser. Publish from a backend, not from client-side code.

### SMS instead of email

Same call, three changes: `DetailType: "sms"`, `channel: "sms"`, and `phoneNumber` in E.164
format instead of `mail`.

```python
"Detail": json.dumps({
    "idempotencyKey": f"otp-{session_id}",
    "product": "demo",
    "channel": "sms",
    "feature": "otp",
    "language": "es",
    "phoneNumber": "+573001234567",   # E.164
    "code": "482913",                 # -> {{code}} in the template
})
```

### Single-region deployment

Drop `EndpointId` and publish straight to the bus. No CRT package needed, plain SigV4:

```python
events.put_events(Entries=[{ "EventBusName": BUS_NAME, ... }])
```

---

## 4. IAM policy for the producer

Grant `PutEvents` on the bus in **both** Regions — the endpoint may route to either one.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "events:PutEvents",
      "Resource": [
        "arn:aws:events:us-east-1:<account>:event-bus/<prefix>-messages-bus",
        "arn:aws:events:us-west-2:<account>:event-bus/<prefix>-messages-bus"
      ]
    }
  ]
}
```

Granting only the primary Region works right up until a failover, then silently starts
failing — which is the worst possible moment to discover it.

---

## 5. Gotchas that will cost you an afternoon

**1. `EventBusName` is required *alongside* `EndpointId`.** Even though you are no longer
addressing the bus directly, EventBridge uses the name to validate the endpoint
configuration. Omitting it fails the entry.

**2. Global STS credentials cannot sign SigV4A.** If you assume a role via
`sts.amazonaws.com`, the vended credentials do not support SigV4A by default. Use the
**regional** STS endpoint (`sts_regional_endpoints="regional"` in Python; the JS SDK v3
defaults to regional). Lambda and ECS task credentials are already regional.

**3. `FailedEntryCount` must be checked.** `PutEvents` returns HTTP 200 even when individual
entries were rejected. A publish that "succeeded" can have delivered nothing. Both examples
above check it — keep that check.

**4. Failover is not instantaneous — you must retry.** The Route 53 health check needs
**several minutes** to mark the primary unhealthy, so during a regional degradation your
`PutEvents` calls can fail *before* traffic is rerouted. The endpoint protects the pipeline,
not your in-flight calls. Producers should use exponential backoff plus, for
business-critical messages, a durable store-and-forward buffer (local queue / outbox) so a
failed publish is replayed rather than lost. This is producer-side work the hub cannot do
for you.

**5. Reuse the same `idempotencyKey` on retries — that is the point.** The key is how the hub
suppresses duplicates across SQS retries, replays and cross-region replication. Generating a
fresh UUID per attempt defeats it and sends the message twice. Derive it from your business
identity (`welcome-{orderId}`), not from the attempt. Charset `[A-Za-z0-9_-]`, max 256.

**6. A successful publish does not mean the message was delivered.** It means EventBridge
accepted the event. Delivery outcome (inbox, spam quarantine, bounce) is visible through the
audit trail — see
[Did the message actually arrive?](../README.md#did-the-message-actually-arrive) and the
saved Athena queries.

---

## 6. Verifying your integration

```bash
# 1. Confirm the endpoint is healthy
aws events describe-endpoint --name <prefix>-endpoint --region <primaryRegion> \
  --query '{State:State,Health:EndpointUrl}'

# 2. Publish one event from your app, then confirm it was processed
aws logs filter-log-events \
  --log-group-name /aws/lambda/<prefix>-send-email \
  --filter-pattern '"<your-idempotency-key>"' \
  --region <primaryRegion>

# 3. Confirm the delivery outcome (Athena saved query)
#    <prefix>-delivery-outcome   -> accepted vs delivered/bounced per message
```

If the event never appears in the Lambda logs, check in this order: `FailedEntryCount` in
your response, then the producer's IAM policy, then that `Source` is exactly
`eventbridge.messages` and `DetailType` is exactly `email` or `sms` — the routing rules match
on those literal values.

---

## Reference

- Event contract and field semantics: [`../README.md#message-contract`](../README.md#message-contract)
- Idempotency semantics: [`idempotency-and-audit.md`](./idempotency-and-audit.md)
- Delivery visibility: [`../README.md#did-the-message-actually-arrive`](../README.md#did-the-message-actually-arrive)
- AWS docs: [Global endpoints in EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-global-endpoints.html) · [`PutEvents` API](https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEvents.html)

*Content on this page was written from the AWS documentation linked above; requirements were
verified against the deployed dev stack.*
