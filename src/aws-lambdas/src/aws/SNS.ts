import { SNSClient, PublishCommand, PublishCommandInput, PublishCommandOutput } from "@aws-sdk/client-sns";
import { Logger } from "@aws-lambda-powertools/logger";
import { Prettify } from "../utils/UtilTypes";
import { BusinessError } from "../../layer/commons/BusinessError";
import { Errors } from "../../layer/commons/ErrorConstant";
import { HTTP_CONSTANT } from "../../layer/commons/HttpConstant";
import { AWS_REGION } from "../../layer/commons/UtilsConstans";

export type SNSPublishInput = Prettify<PublishCommandInput>;
export type SNSPublishOutput = Prettify<PublishCommandOutput>;

const logger = new Logger({ serviceName: "SNSUtil" });

export class SNSUtil {
    private snsClient: SNSClient;

    constructor({ region = AWS_REGION }: { region?: string } = {}) {
        this.snsClient = new SNSClient({ region });
    }

    public async publish(publishInput: SNSPublishInput): Promise<SNSPublishOutput> {
        let response;
        const command = new PublishCommand(publishInput);
        try {
            response = await this.snsClient.send(command);
            logger.info("SMS sent successfully");
            return response;
        } catch (error) {
            if (error instanceof Error) {
                logger.error(error.message);
            }
            throw new BusinessError({
                code: Errors.SNS.code,
                httpCode: HTTP_CONSTANT.INTERNAL_SERVER_ERROR.httpCode,
                messages: [Errors.SNS.message],
            });
        }
    }
}
