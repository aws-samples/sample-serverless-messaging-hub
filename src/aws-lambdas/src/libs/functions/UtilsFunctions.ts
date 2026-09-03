import Handlebars from 'handlebars';
import { createSESTemplate, EmailConfig } from '../../utils/SESConfig';

const CHARSET = 'UTF-8';

export interface DetailParams {
    idempotencyKey: string;
    product: string;
    channel: string;
    feature: string;
    language: string;
    mail?: string | string[];
    subject?: string;
    phoneNumber?: string;
    [key: string]: unknown;
}

export function generateTemplate(parameters: Record<string, unknown>, document: string): string {
    const template = Handlebars.compile(document);
    return template(parameters);
}

/**
 * Builds the SES SendEmail input from the event detail and a pre-fetched
 * email configuration ({ configuration, template }). The config is fetched by
 * the caller so it can also derive the idempotency TTL from the same read.
 */
export function generateEmailMessage(detail: DetailParams, emailConfig: EmailConfig) {
    const { mail, subject, idempotencyKey } = detail;
    if (!mail) {
        throw new Error('mail is required for email channel');
    }
    const htmlMessage = generateTemplate(detail, emailConfig.template);

    // Attach the SES Configuration Set + idempotencyKey message tag so
    // delivery/bounce/complaint events can be correlated back to this message
    // (non-repudiation). Only set when a configuration set is configured.
    const configurationSetName = process.env.SES_CONFIGURATION_SET || undefined;
    const tags = configurationSetName ? [{ name: 'idempotencyKey', value: idempotencyKey }] : undefined;

    return createSESTemplate({
        toAddresses: mail,
        subject,
        configurationSubject: emailConfig.configuration.subject,
        htmlMessage,
        charset: CHARSET,
        source: emailConfig.configuration.source,
        configurationSetName,
        tags,
    });
}

/**
 * Builds the SNS Publish input from the event detail and a pre-fetched template
 * configuration (which carries the inline SMS `template`).
 */
export function generateSMSMessage(detail: DetailParams, configuration: Record<string, string>) {
    const { phoneNumber } = detail;
    if (!phoneNumber) {
        throw new Error('phoneNumber is required for sms channel');
    }

    const message = generateTemplate(detail, configuration.template);

    // Notifications sent by this hub are transactional (account lifecycle,
    // security, operational alerts) — never marketing. Transactional messages
    // get delivery priority and are not subject to promotional opt-out rules.
    const messageAttributes: Record<string, { DataType: string; StringValue: string }> = {
        'AWS.SNS.SMS.SMSType': {
            DataType: 'String',
            StringValue: 'Transactional',
        },
    };

    // Sender ID is optional and region-restricted (e.g. NOT supported in the
    // US/Canada, max 11 alphanumeric chars). It is provided via config, not
    // hardcoded to the product name, to keep the hub portable.
    const senderId = process.env.SMS_SENDER_ID;
    if (senderId && senderId.trim() !== '') {
        messageAttributes['AWS.SNS.SMS.SenderID'] = {
            DataType: 'String',
            StringValue: senderId,
        };
    }

    return {
        PhoneNumber: phoneNumber,
        Message: message,
        MessageAttributes: messageAttributes,
    };
}
