import { Context, SQSEvent } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { SendEmailService } from '../services/SendEmailService';
import { CHANNEL_TYPES } from '../common/UtilsConstants';
import { createRequestPayload } from '../libs/validators/RequestValidator';
import { Validator } from '../common/Validator';

const serviceName = 'SendEmailController';
const logger = new Logger({ serviceName });
const tracer = new Tracer({ serviceName });

const sendEmailLambda = async (event: SQSEvent, context: Context): Promise<void> => {
    logger.addContext(context);
    logger.info('Event received', { recordCount: event.Records.length });

    tracer.putAnnotation('awsRequestId', context.awsRequestId);

    Validator.validateSQSPayload(event, createRequestPayload(CHANNEL_TYPES.EMAIL));
    await SendEmailService.send(event);
};

export const handler = middy(sendEmailLambda)
    .use(captureLambdaHandler(tracer))
    .use(injectLambdaContext(logger, { clearState: true }));
