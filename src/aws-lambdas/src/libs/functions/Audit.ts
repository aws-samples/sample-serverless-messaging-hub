import { createHash } from 'crypto';
import { FirehoseClient, PutRecordCommand } from '@aws-sdk/client-firehose';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'Audit' });

// Singleton — reused across warm invocations.
const firehoseClient = new FirehoseClient({});

export interface AcceptanceRecord {
    idempotencyKey: string;
    product: string;
    channel: string;
    feature: string;
    language: string;
    /** Raw recipient (email or phone); hashed before persisting (PII minimization). */
    recipient: string;
    providerMessageId?: string;
    status: 'ACCEPTED' | 'FAILED';
}

function hashRecipient(recipient: string): string {
    return createHash('sha256').update(recipient).digest('hex');
}

/**
 * Writes a non-repudiation audit record to the Firehose delivery stream.
 *
 * Best-effort by design: the message was already sent, so a failure to archive
 * must NEVER fail the handler (that would trigger an SQS retry and a duplicate
 * send). Failures are logged for later reconciliation.
 */
export async function recordAcceptance(record: AcceptanceRecord): Promise<void> {
    const streamName = process.env.AUDIT_FIREHOSE_STREAM;
    if (!streamName) {
        logger.warn('AUDIT_FIREHOSE_STREAM not set; skipping audit record');
        return;
    }

    const payload = {
        idempotencyKey: record.idempotencyKey,
        product: record.product,
        channel: record.channel,
        feature: record.feature,
        language: record.language,
        recipientHash: hashRecipient(record.recipient),
        status: record.status,
        providerMessageId: record.providerMessageId ?? null,
        region: process.env.AWS_REGION ?? 'unknown',
        timestamp: new Date().toISOString(),
    };

    try {
        await firehoseClient.send(
            new PutRecordCommand({
                DeliveryStreamName: streamName,
                Record: { Data: Buffer.from(`${JSON.stringify(payload)}\n`) },
            }),
        );
    } catch (error) {
        logger.error('Failed to write audit record (best-effort)', {
            error,
            idempotencyKey: record.idempotencyKey,
        });
    }
}
