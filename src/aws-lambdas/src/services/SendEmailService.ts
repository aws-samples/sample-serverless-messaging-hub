import {Logger} from "@aws-lambda-powertools/logger";
import {Tracer} from "@aws-lambda-powertools/tracer";
import {SQSEvent} from "aws-lambda";
import {generateEmailMessage} from "../libs/functions/UtilsFunctions";
import {SQSUtil} from "../aws/SQS";
import {SESUtil} from "../aws/SES";

const serviceName = "SendEmailService";
const logger = new Logger({serviceName: serviceName});
const tracer = new Tracer({serviceName: serviceName});
const urlSQS = process.env.URL_SQS_RECEIPT_EMAIL as string;
const sqsUtil = new SQSUtil();
const sesUtil = new SESUtil();

export default class SendEmailService {

    @tracer.captureMethod()
    static async send(event: SQSEvent) {
        tracer.annotateColdStart();
        tracer.addServiceNameAnnotation();
        let detail;

        try {
            if (event.Records) {
                detail = JSON.parse(event.Records[0].body).detail;
            }
            const input = await generateEmailMessage(detail);
            await sesUtil.sendEmail(input);
            await sqsUtil.deleteMessage(event.Records[0].receiptHandle, urlSQS);
        } catch (error) {
            logger.error("Error parsing event", {error});
            throw error;
        }
    }
}
