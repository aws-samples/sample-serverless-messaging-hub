import {
    DeleteMessageCommand,
    DeleteMessageCommandInput,
    SQSClient
} from "@aws-sdk/client-sqs";
import { Logger } from "@aws-lambda-powertools/logger";
import { Prettify } from "../utils/UtilTypes";
import { BusinessError } from "../../layer/commons/BusinessError";
import { HTTP_CONSTANT } from "../../layer/commons/HttpConstant";
import { Errors } from "../../layer/commons/ErrorConstant";
import { AWS_REGION } from "../../layer/commons/UtilsConstans";

export type SQSDeleteMessageInput = Prettify<DeleteMessageCommandInput>;

const logger = new Logger({ serviceName: "SQSUtil" });

export class SQSUtil {
    private sqsClient: SQSClient;

    constructor({ region = AWS_REGION }: { region?: string } = {}) {
        this.sqsClient = new SQSClient({ region });
    }

    public async deleteMessage(receiptHandle: string, queueUrl: string): Promise<void> {
        const deleteMessageInput: SQSDeleteMessageInput = {
            QueueUrl: queueUrl,
            ReceiptHandle: receiptHandle,
        };

        const command = new DeleteMessageCommand(deleteMessageInput);
        try {
            await this.sqsClient.send(command);
            logger.info("Delete Message SQS", { response: "Message deleted successfully" });
        } catch (error) {
            if (error instanceof Error) {
                logger.error(error.message);
            }
            throw new BusinessError({
                code: Errors.SQS.code,
                httpCode: HTTP_CONSTANT.INTERNAL_SERVER_ERROR.httpCode,
                messages: [Errors.SQS.message],
            });
        }
    }
}
