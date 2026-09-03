import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { SQSEvent } from 'aws-lambda';
import { generateEmailMessage, DetailParams } from '../libs/functions/UtilsFunctions';
import { EmailConfigService } from '../utils/SESConfig';
import { runOnce, resolveIdempotencyTtlSeconds } from '../libs/functions/Idempotency';
import { recordAcceptance } from '../libs/functions/Audit';
import { sesClient } from '../aws/SES';
import { SendEmailCommand } from '@aws-sdk/client-ses';

const serviceName = 'SendEmailService';
const logger = new Logger({ serviceName });
const tracer = new Tracer({ serviceName });

/**
 * Processes SQS email events.
 * The actual SES send is wrapped in an idempotency guard keyed by the
 * producer-supplied `idempotencyKey`, so duplicates (SQS retries, replays,
 * cross-region failover) do not send the email more than once.
 * Lambda deletes the SQS message on successful return; on error it returns to
 * the queue for retry (up to DLQ maxReceiveCount).
 */
export class SendEmailService {
    @tracer.captureMethod()
    static async send(event: SQSEvent): Promise<void> {
        tracer.annotateColdStart();
        tracer.addServiceNameAnnotation();

        const detail = JSON.parse(event.Records[0].body).detail as DetailParams;
        const { idempotencyKey, product, channel, feature, language } = detail;
        logger.info('Processing email', { product, feature, idempotencyKey });

        // Read config first (side-effect free) so we can derive the per-template TTL.
        const emailConfig = await EmailConfigService.getEmailConfig({ product, channel, feature, language });
        const ttlSeconds = resolveIdempotencyTtlSeconds(emailConfig.configuration);

        await runOnce(idempotencyKey, ttlSeconds, async () => {
            const input = generateEmailMessage(detail, emailConfig);
            const result = await sesClient.send(new SendEmailCommand(input));
            logger.info('Email sent successfully', {
                to: detail.mail,
                idempotencyKey,
                providerMessageId: result.MessageId,
            });

            const recipient = Array.isArray(detail.mail) ? detail.mail.join(',') : String(detail.mail);
            await recordAcceptance({
                idempotencyKey,
                product,
                channel,
                feature,
                language,
                recipient,
                providerMessageId: result.MessageId,
                status: 'ACCEPTED',
            });
        });
    }
}
