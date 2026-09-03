import { SQSEvent } from 'aws-lambda';
import { BusinessError } from './BusinessError';
import { Errors } from './ErrorConstant';
import { HTTP_CONSTANT } from './HttpConstant';
import * as z from 'zod';

/**
 * Validates incoming SQS event payloads against Zod schemas.
 */
export class Validator {
    public static validateSQSPayload(event: SQSEvent, sqsBodyValidator: z.ZodTypeAny): void {
        if (event.Records.length === 0) {
            throw new BusinessError({
                code: Errors.REQUEST_SQS.code,
                httpCode: HTTP_CONSTANT.BAD_REQUEST.httpCode,
                messages: [Errors.REQUEST_SQS.message],
            });
        }

        const parseResults = event.Records.map((record) =>
            sqsBodyValidator.safeParse(JSON.parse(record.body ?? '{}')),
        );

        const failedResults = parseResults.filter((result) => !result.success);
        if (failedResults.length > 0) {
            const errorMessages = failedResults
                .flatMap((result) =>
                    result.success
                        ? []
                        : result.error.errors.map((err) => `${err.path.join('.')}: ${err.message}`),
                )
                .join(', ');

            throw new BusinessError({
                code: Errors.REQUEST_SQS.code,
                httpCode: HTTP_CONSTANT.BAD_REQUEST.httpCode,
                messages: [errorMessages],
            });
        }
    }
}
