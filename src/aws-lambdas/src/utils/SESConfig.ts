import {getConfigurationItem} from "../libs/functions/DynamoDbOperations";
import {getTemplate} from "../libs/functions/S3Operations";
import {MessagingTemplateFilter} from "./UtilTypes";

export interface SESTemplateParams {
    toAddresses: string | string[];
    subject?: string;
    configurationSubject?: string;
    htmlMessage: string;
    charset?: string;
    source: string;
}

export interface EmailConfig {
    configuration: any;
    template: string;
}

export class EmailConfigService {
    private static readonly TEMPLATE_PATH = (filter: MessagingTemplateFilter) =>
        `${filter.product}/${filter.language}/${filter.feature}.html`;

    public static async getEmailConfig(messagingFilter: MessagingTemplateFilter): Promise<EmailConfig> {
        try {
            const [configuration, template] = await Promise.all([
                getConfigurationItem(messagingFilter),
                getTemplate(this.TEMPLATE_PATH(messagingFilter))
            ]);

            return { configuration, template };
        } catch (error) {
            throw new Error(`Failed to get email configuration: 
            ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
}

export const createSESTemplate = ({
                                      toAddresses,
                                      subject,
                                      configurationSubject,
                                      htmlMessage,
                                      charset = 'UTF-8',
                                      source
                                  }: SESTemplateParams) => {

    if (!toAddresses) throw new Error('toAddresses is required');
    if (!htmlMessage) throw new Error('htmlMessage is required');
    if (!source) throw new Error('source is required');

    return {
        Destination: {
            ToAddresses: [`${toAddresses}`],
        },
        Message: {
            Body: {
                Html: {
                    Charset: charset,
                    Data: htmlMessage,
                },
            },
            Subject: {
                Charset: charset,
                Data: subject || configurationSubject,
            },
        },
        Source: source,
    }
};