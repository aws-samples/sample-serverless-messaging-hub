import { Context, SQSEvent } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { SendSmsService } from '../services/SendSmsService';
import { Validator } from '../common/Validator';
import { createRequestPayload } from '../libs/validators/RequestValidator';
import { CHANNEL_TYPES } from '../common/UtilsConstants';

const serviceName = 'SendSmsController';
const logger = new Logger({ serviceName });
const tracer = new Tracer({ serviceName });

const sendSmsLambda = async (event: SQSEvent, context: Context): Promise<void> => {
    logger.addContext(context);
    logger.info('Event received', { recordCount: event.Records.length });

    tracer.putAnnotation('awsRequestId', context.awsRequestId);

    Validator.validateSQSPayload(event, createRequestPayload(CHANNEL_TYPES.SMS));
    await SendSmsService.send(event);
};

export const handler = middy(sendSmsLambda)
    .use(captureLambdaHandler(tracer))
    .use(injectLambdaContext(logger, { clearState: true }));
