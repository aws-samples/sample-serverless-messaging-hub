import { SESClient } from '@aws-sdk/client-ses';

/**
 * Singleton SES client — reused across warm Lambda invocations.
 */
export const sesClient = new SESClient({});
