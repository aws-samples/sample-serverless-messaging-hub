import { CHANNEL_TYPES } from "../../layer/commons/UtilsConstans";

export interface MessagingTemplateFilter {
    product: string;
    channel: string;
    feature: string;
    language: string;
}

export type Prettify<T> = {
    [P in keyof T]: T[P];
} & unknown;

export type ChannelType = (typeof CHANNEL_TYPES)[keyof typeof CHANNEL_TYPES];
