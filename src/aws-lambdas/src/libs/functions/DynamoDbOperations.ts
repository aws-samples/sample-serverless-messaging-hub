import { unmarshall } from "@aws-sdk/util-dynamodb";
import { MessagingTemplateFilter } from "../../utils/UtilTypes";
import { DynamoDbUtil } from "../../aws/DynamoDb";
import { Errors } from "../../../layer/commons/ErrorConstant";
import { Logger } from "@aws-lambda-powertools/logger";

const serviceName = "DynamoDbOperations";
const logger = new Logger({ serviceName: serviceName });
export async function getConfigurationItem(messagingFilter: MessagingTemplateFilter) {
    const dynamoDbUtil = new DynamoDbUtil();

    const { product, channel, feature, language } = messagingFilter;
    try {
        const configurationItem = await dynamoDbUtil.getItem({
            TableName: process.env.MESSAGING_TABLE_NAME,
            Key: {
                product: {
                    S: product,
                },
                filterKey: {
                    S: `${channel}#${feature}#${language}`,
                },
            },
        });

        if (!configurationItem?.Item) {
            throw new Error("No template found for the given product, channel, feature and language");
        }

        return unmarshall(configurationItem.Item);
    } catch (error) {
        logger.error(Errors.DATABASE.message, { error });
        throw error;
    }
}
