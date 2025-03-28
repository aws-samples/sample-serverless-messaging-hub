import { z } from "zod";
import { ChannelType } from "../../utils/UtilTypes";
import { CHANNEL_TYPES } from "../../../layer/commons/UtilsConstans";

const smsDetail = z.object({
    product: z.string(),
    channel: z.string(),
    feature: z.string(),
    language: z.string(),
    phoneNumber: z.string(),
});

const emailDetail = z.object({
    product: z.string(),
    channel: z.string(),
    feature: z.string(),
    language: z.string(),
    mail: z.string(),
});

function getDetailSchema(type: ChannelType) {
    switch (type) {
        case CHANNEL_TYPES.SMS:
            return smsDetail;
        case CHANNEL_TYPES.EMAIL:
            return emailDetail;
        default:
            throw new Error(`Unsupported request type: ${type}`);
    }
}

export function createRequestPayload(type: ChannelType) {
    return z.object({
        detail: getDetailSchema(type),
    });
}