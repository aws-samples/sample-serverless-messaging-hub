import { SESClient, SendEmailCommand, SendEmailCommandInput, SendEmailCommandOutput } from "@aws-sdk/client-ses";
import { Logger } from "@aws-lambda-powertools/logger";
import { Prettify } from "../utils/UtilTypes";
import { BusinessError } from "../../layer/commons/BusinessError";
import { Errors } from "../../layer/commons/ErrorConstant";
import { HTTP_CONSTANT } from "../../layer/commons/HttpConstant";
import { AWS_REGION } from "../../layer/commons/UtilsConstans";
export type SESSendEmailInput = Prettify<SendEmailCommandInput>;
export type SESSendEmailOutput = Prettify<SendEmailCommandOutput>;

const logger = new Logger({ serviceName: "SESUtil" });

export class SESUtil {
    private sesClient: SESClient;

    constructor({ region = AWS_REGION }: { region?: string } = {}) {
        this.sesClient = new SESClient({ region });
    }

    public async sendEmail(sendEmailInput: SESSendEmailInput): Promise<SESSendEmailOutput> {
        let response;
        const command = new SendEmailCommand(sendEmailInput);
        try {
            response = await this.sesClient.send(command);
            return response;
        } catch (error) {
            if (error instanceof Error) {
                logger.error(error.message);
            }
            throw new BusinessError({
                code: Errors.SES.code,
                httpCode: HTTP_CONSTANT.INTERNAL_SERVER_ERROR.httpCode,
                messages: [Errors.SES.message],
            });
        }
    }
}
