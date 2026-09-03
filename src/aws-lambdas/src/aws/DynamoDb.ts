import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

/**
 * Singleton DynamoDB client — reused across warm Lambda invocations.
 */
export const dynamoDbClient = new DynamoDBClient({});
