import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import { dynamoDbClient } from '../../aws/DynamoDb';
import { MessagingTemplateFilter } from '../../utils/UtilTypes';

const logger = new Logger({ serviceName: 'DynamoDbOperations' });

export async function getConfigurationItem(messagingFilter: MessagingTemplateFilter) {
    const { product, channel, feature, language } = messagingFilter;

    try {
        const command = new GetItemCommand({
            TableName: process.env.MESSAGING_TABLE_NAME,
            Key: {
                product: { S: product },
                filterKey: { S: `${channel}#${feature}#${language}` },
            },
        });

        const result = await dynamoDbClient.send(command);

        if (!result?.Item) {
            throw new Error(`No template found for ${product}/${channel}/${feature}/${language}`);
        }

        return unmarshall(result.Item);
    } catch (error) {
        logger.error('Failed to get configuration item', { error, messagingFilter });
        throw error;
    }
}
