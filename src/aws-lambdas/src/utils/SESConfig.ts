import { getConfigurationItem } from '../libs/functions/DynamoDbOperations';
import { getTemplate } from '../libs/functions/S3Operations';
import { MessagingTemplateFilter } from './UtilTypes';

export interface SESTemplateParams {
    toAddresses: string | string[];
    subject?: string;
    configurationSubject?: string;
    htmlMessage: string;
    charset?: string;
    source: string;
    configurationSetName?: string;
    tags?: { name: string; value: string }[];
}

export interface EmailConfig {
    configuration: Record<string, string>;
    template: string;
}

export class EmailConfigService {
    /**
     * Loads the email configuration for a given message.
     *
     * The S3 object key for the HTML body is taken from the DynamoDB item's
     * `templatePath` attribute (single source of truth), NOT derived from a
     * naming convention. This keeps the storage layout flexible and portable:
     * a template can live at any key as long as the DB row points to it.
     */
    public static async getEmailConfig(messagingFilter: MessagingTemplateFilter): Promise<EmailConfig> {
        const configuration = await getConfigurationItem(messagingFilter);

        const templatePath = configuration.templatePath;
        if (!templatePath || typeof templatePath !== 'string') {
            const { product, channel, feature, language } = messagingFilter;
            throw new Error(
                `Configuration for ${product}/${channel}/${feature}/${language} is missing a valid "templatePath" attribute`,
            );
        }

        const template = await getTemplate(templatePath);

        return { configuration, template };
    }
}

export function createSESTemplate({
    toAddresses,
    subject,
    configurationSubject,
    htmlMessage,
    charset = 'UTF-8',
    source,
    configurationSetName,
    tags,
}: SESTemplateParams) {
    if (!toAddresses) throw new Error('toAddresses is required');
    if (!htmlMessage) throw new Error('htmlMessage is required');
    if (!source) throw new Error('source is required');

    return {
        Destination: {
            ToAddresses: Array.isArray(toAddresses) ? toAddresses : [toAddresses],
        },
        Message: {
            Body: {
                Html: { Charset: charset, Data: htmlMessage },
            },
            Subject: {
                Charset: charset,
                Data: subject || configurationSubject,
            },
        },
        Source: source,
        ...(configurationSetName ? { ConfigurationSetName: configurationSetName } : {}),
        ...(tags && tags.length > 0
            ? { Tags: tags.map((t) => ({ Name: t.name, Value: t.value })) }
            : {}),
    };
}
