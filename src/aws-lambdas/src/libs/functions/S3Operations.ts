import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Logger } from '@aws-lambda-powertools/logger';
import { s3Client } from '../../aws/S3';

const logger = new Logger({ serviceName: 'S3Operations' });

export async function getTemplate(fileName: string): Promise<string> {
    if (!fileName || fileName.trim() === '') {
        throw new Error('fileName is required');
    }

    const bucket = process.env.MESSAGING_TEMPLATES_BUCKET;
    if (!bucket) {
        throw new Error('MESSAGING_TEMPLATES_BUCKET environment variable is not set');
    }

    try {
        const command = new GetObjectCommand({ Bucket: bucket, Key: fileName });
        const response = await s3Client.send(command);

        if (!response.Body) {
            throw new Error('Empty response body from S3');
        }

        return response.Body.transformToString('utf-8');
    } catch (error) {
        logger.error('Failed to get template from S3', { error, fileName, bucket });
        throw error;
    }
}
