import { S3Client } from '@aws-sdk/client-s3';

/**
 * Singleton S3 client — reused across warm Lambda invocations.
 */
export const s3Client = new S3Client({});
