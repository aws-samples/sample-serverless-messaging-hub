import { Context, SQSEvent } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { captureLambdaHandler } from "@aws-lambda-powertools/tracer/middleware";
import middy from "@middy/core";
import SendSmsService from "../services/SendSmsService";
import { Validator } from "../../layer/commons/Validator";
import { createRequestPayload } from "../libs/validators/RequestValidator";
import { CHANNEL_TYPES } from "../../layer/commons/UtilsConstans";

const serviceName = "SendSmsLambdaController";
const logger = new Logger({ serviceName: serviceName });
const tracer = new Tracer({ serviceName: serviceName });

/**
 * General Handler.
 * @param {SQSEvent} event - The event object of the request received.
 * @param {Context} context - Lambda Context
 * LambdaPowerTools Logger - See also: https://docs.powertools.aws.dev/lambda/typescript/latest/core/logger/
 * LambdaPowerTools Tracer - See also: https://docs.powertools.aws.dev/lambda/typescript/latest/core/tracer/
 */
export const sendSmsLambda = async (event: SQSEvent, context: Context): Promise<any> => {
    logger.addContext(context);
    logger.info("Event", { event: event });

    tracer.putAnnotation("awsRequestId", context.awsRequestId);
    tracer.putMetadata("eventPayload", event);

    try {
        Validator.validateSQSPayload(event, createRequestPayload(CHANNEL_TYPES.SMS));
        await SendSmsService.push(event);
    } catch (error) {
        logger.error("Error", { error: error });
        throw new Error(error as any);
    }
};

export const handler = middy(sendSmsLambda)
    .use(captureLambdaHandler(tracer))
    .use(injectLambdaContext(logger, { clearState: true }));
