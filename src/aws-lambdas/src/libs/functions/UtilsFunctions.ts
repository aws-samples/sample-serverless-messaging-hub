import Handlebars from "handlebars";
import {createSESTemplate, EmailConfig, EmailConfigService} from "../../utils/SESConfig";
import {MessagingTemplateFilter} from "../../utils/UtilTypes";
import {getConfigurationItem} from "./DynamoDbOperations";
const charset = "UTF-8";

export interface DetailParams {
    product: string;
    channel: string;
    feature: string;
    language: string;
    mail: string | string[];
    subject: string;
    phoneNumber: string;
}
export function generateTemplate(parameters: any, document: string): string {
    const template = Handlebars.compile(document);
    return template(parameters);
}

export async function generateEmailMessage(detail: DetailParams) {
    const {product, channel, feature, language, mail, subject} = detail;
    const toAddresses: string | string[] = mail;
    const emailConfig: EmailConfig = await
    EmailConfigService.getEmailConfig({product, channel, feature, language});

    const htmlMessage = generateTemplate(detail, emailConfig.template);
    return createSESTemplate({
        toAddresses,
        subject,
        configurationSubject: emailConfig.configuration.subject,
        htmlMessage,
        charset,
        source: emailConfig.configuration.source
    });
}

export async function generateSMSMessage(detail: DetailParams) {
    const { product, channel, feature, language, phoneNumber } = detail;
    const messagingFilter: MessagingTemplateFilter = { product, channel, feature, language };

    const configuration = await getConfigurationItem(messagingFilter);
    if (!configuration) {
        throw new Error("No template found for the given product, channel, feature and language");
    }
    const messageAttributes: { [key: string]: { DataType: string; StringValue: string } } = {
        "AWS.SNS.SMS.SenderID": {
            DataType: "String",
            StringValue: product,
        },
        "AWS.SNS.SMS.SMSType": {
            DataType: "String",
            StringValue: "Promotional",
        },
    };
    const template = configuration.template;

    const htmlMessage = generateTemplate(detail, template);

    return {
        PhoneNumber: phoneNumber,
        Message: htmlMessage,
        MessageAttributes: messageAttributes,
    };
}
