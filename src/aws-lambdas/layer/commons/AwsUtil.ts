import { HTTP_CONSTANT } from './HttpConstant';
import { BusinessError } from './BusinessError';

/**
 @description Common headers for AWS Lambda responses
 */
export const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': true,
    'X-Content-Type-Options': 'nosniff',
    'X-XSS-Protection': '1; mode=block',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer-when-downgrade',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

/**
 @description Utility class for handling requests and responses in AWS Lambda
 */
export class AwsUtil {
    /**
     * @description Parses the body of an AWS Lambda request
     * @param {any} event - AWS Lambda event object
     * @returns Object with request body
     */
    static getRequest(event: any) {
        let body;

        if (event.body === null) {
            return {};
        }

        if (event.body) {
            body = JSON.parse(event.body);
        } else {
            body = event;
        }

        return body;
    }

    /**
     * @description Builds a successful AWS Lambda response
     * @param {Object} payload - Object with the response content
     * @returns {Object} - Object with the constructed response
     */
    static buildResponse(payload: object): any {
        return {
            statusCode: HTTP_CONSTANT.OK.httpCode,
            body: JSON.stringify(payload),
            headers,
        };
    }

    /**
     * @description Builds an AWS Lambda error response
     * @param {any} event - AWS Lambda event object
     * @param {any} error - Object with error information
     * @returns Object with constructed response
     */
    static async buildErrorResponse(event: any, error: any): Promise<any> {
        const statusCode =
            error instanceof BusinessError ? error.httpCode : HTTP_CONSTANT.INTERNAL_SERVER_ERROR.httpCode;

        return {
            statusCode: statusCode,
            body: JSON.stringify({
                payload: this.getRequest(event),
                status: {
                    success: false,
                    error: error?.messages,
                },
            }),
            headers: headers,
        };
    }
}
