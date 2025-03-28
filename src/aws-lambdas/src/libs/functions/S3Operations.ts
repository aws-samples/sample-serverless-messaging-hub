import {Logger} from "@aws-lambda-powertools/logger";
import {S3GetObjectInput, S3Util} from "../../aws/S3";

const serviceName = "S3Operations";
const s3Util = new S3Util();
const logger = new Logger({serviceName: serviceName});

export async function getTemplate(fileName: string): Promise<string> {
    if (!fileName || fileName.trim() === '') {
        throw new Error('fileName is required');
    }

    if (!process.env.MESSAGING_TEMPLATES_BUCKET) {
        throw new Error('MESSAGING_TEMPLATES_BUCKET environment variable is not set');
    }

    try {
        const getObjectInput: S3GetObjectInput = {
            Bucket: process.env.MESSAGING_TEMPLATES_BUCKET,
            Key: fileName,
        };

        const response = await s3Util.getObject(getObjectInput);

        if (!response.Body) {
            throw new Error('Empty response body from S3');
        }

        return response.Body.transformToString("utf-8");
    } catch (error) {
        logger.error('Failed to get template from S3', {
            error,
            fileName,
            bucket: process.env.MESSAGING_TEMPLATES_BUCKET
        });

        if (error instanceof Error) {
            throw new Error(`Failed to get template: ${error.message}`);
        }
        throw error;
    }
}
