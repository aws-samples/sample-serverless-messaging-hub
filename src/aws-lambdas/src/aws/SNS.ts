import { SNSClient } from '@aws-sdk/client-sns';

/**
 * Singleton SNS client — reused across warm Lambda invocations.
 */
export const snsClient = new SNSClient({});
