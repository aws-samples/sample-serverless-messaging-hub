import { SQSEvent } from "aws-lambda";
import { BusinessError } from "./BusinessError";
import { Errors } from "./ErrorConstant";
import { HTTP_CONSTANT } from "./HttpConstant";
import * as z from "zod";
/**
 * Class in order to validate the received requests.
 * @class Validator
 */
export class Validator {
    /**
     * Static method to validate an SQS payload.
     * @param {SQSEvent} event - The SQS event object.
     * @param {z.ZodTypeAny} sqsBodyValidator - The validation scheme to be used.
     * @throws {BusinessError} - If the validation fails, a business error is thrown with details of the problem.
     */
    public static validateSQSPayload(event: SQSEvent, sqsBodyValidator: z.ZodTypeAny) {
        if (event.Records.length === 0) {
            throw new BusinessError({
                code: Errors.SQS.code,
                httpCode: HTTP_CONSTANT.BAD_REQUEST.httpCode,
                messages: [Errors.REQUEST_SQS.message],
            });
        }

        const parseResults = event?.Records?.map((record) =>
            sqsBodyValidator.safeParse(JSON.parse(record.body ?? "{}")),
        );
        const failedResults = parseResults.filter((result) => !result.success);
        if (failedResults.length > 0) {
            const errorMessages = failedResults
                .flatMap((result) =>
                    result.success
                        ? []
                        : result.error.errors.map((error) => `${error.path.join(".")}: ${error.message}`),
                )
                .join(", ");
            throw Error(errorMessages);
        }
    }
}
