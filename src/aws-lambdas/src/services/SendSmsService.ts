import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { SQSEvent } from 'aws-lambda';
import { generateSMSMessage, DetailParams } from '../libs/functions/UtilsFunctions';
import { getConfigurationItem } from '../libs/functions/DynamoDbOperations';
import { runOnce, resolveIdempotencyTtlSeconds } from '../libs/functions/Idempotency';
import { recordAcceptance } from '../libs/functions/Audit';
import { snsClient } from '../aws/SNS';
import { PublishCommand } from '@aws-sdk/client-sns';

const serviceName = 'SendSmsService';
const logger = new Logger({ serviceName });
const tracer = new Tracer({ serviceName });

/**
 * Processes SQS SMS events.
 * The actual SNS publish is wrapped in an idempotency guard keyed by the
 * producer-supplied `idempotencyKey`, so duplicates do not send the SMS more
 * than once.
 * Lambda deletes the SQS message on successful return; on error it returns to
 * the queue for retry (up to DLQ maxReceiveCount).
 */
export class SendSmsService {
    @tracer.captureMethod()
    static async send(event: SQSEvent): Promise<void> {
        tracer.annotateColdStart();
        tracer.addServiceNameAnnotation();

        const detail = JSON.parse(event.Records[0].body).detail as DetailParams;
        const { idempotencyKey, product, channel, feature, language } = detail;
        logger.info('Processing SMS', { product, feature, idempotencyKey });

        const configuration = await getConfigurationItem({ product, channel, feature, language });
        const ttlSeconds = resolveIdempotencyTtlSeconds(configuration);

        await runOnce(idempotencyKey, ttlSeconds, async () => {
            const input = generateSMSMessage(detail, configuration as Record<string, string>);
            const result = await snsClient.send(new PublishCommand(input));
            logger.info('SMS sent successfully', {
                to: detail.phoneNumber,
                idempotencyKey,
                providerMessageId: result.MessageId,
            });

            await recordAcceptance({
                idempotencyKey,
                product,
                channel,
                feature,
                language,
                recipient: String(detail.phoneNumber),
                providerMessageId: result.MessageId,
                status: 'ACCEPTED',
            });
        });
    }
}
