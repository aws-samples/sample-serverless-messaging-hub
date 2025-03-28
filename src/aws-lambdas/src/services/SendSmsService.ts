import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { SQSEvent } from "aws-lambda";
import {generateSMSMessage} from "../libs/functions/UtilsFunctions";
import { SQSUtil } from "../aws/SQS";
import { SNSUtil } from "../aws/SNS";

const serviceName = "SendSmsService";
const logger = new Logger({ serviceName: serviceName });
const tracer = new Tracer({ serviceName: serviceName });
const urlSQS = process.env.URL_SQS_RECEIPT_SMS as string;
const sqsUtil = new SQSUtil();
const snsUtil = new SNSUtil();

export default class SendSmsService {
    @tracer.captureMethod()
    static async push(event: SQSEvent) {
        tracer.annotateColdStart();
        tracer.addServiceNameAnnotation();
        let detail;

        try {
            if (event.Records) {
                detail = JSON.parse(event.Records[0].body).detail;
            }

            const input = await generateSMSMessage(detail);
            await snsUtil.publish(input);
            await sqsUtil.deleteMessage(event.Records[0].receiptHandle, urlSQS);
        } catch (error) {
            logger.error("Error parsing event", { error });
            throw error;
        }
    }
}
