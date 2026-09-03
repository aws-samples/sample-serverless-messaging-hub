import { z } from 'zod';
import { ChannelType } from '../../utils/UtilTypes';
import { CHANNEL_TYPES } from '../../common/UtilsConstants';

/**
 * Email recipient: a single verified address or a non-empty list of addresses.
 * This mirrors what `createSESTemplate` / SES `Destination.ToAddresses` accept.
 */
const emailRecipient = z.union([
    z.string().email(),
    z.array(z.string().email()).min(1),
]);

/**
 * Idempotency key: producer-supplied, immutable, unique per logical message.
 * Constrained to SES message-tag-safe characters ([A-Za-z0-9_-], max 256) so it
 * can also be attached as an SES message tag for delivery-event correlation.
 */
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);

const smsDetail = z.object({
    idempotencyKey,
    product: z.string().min(1),
    channel: z.string().min(1),
    feature: z.string().min(1),
    language: z.string().min(1),
    phoneNumber: z.string().min(1),
});

const emailDetail = z.object({
    idempotencyKey,
    product: z.string().min(1),
    channel: z.string().min(1),
    feature: z.string().min(1),
    language: z.string().min(1),
    mail: emailRecipient,
});

function getDetailSchema(type: ChannelType) {
    switch (type) {
        case CHANNEL_TYPES.SMS:
            return smsDetail;
        case CHANNEL_TYPES.EMAIL:
            return emailDetail;
        default:
            throw new Error(`Unsupported channel type: ${type}`);
    }
}

export function createRequestPayload(type: ChannelType) {
    return z.object({
        detail: getDetailSchema(type),
    });
}
