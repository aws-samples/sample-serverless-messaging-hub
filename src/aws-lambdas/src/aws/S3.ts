import { S3Client, GetObjectCommand, GetObjectCommandInput, GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { Logger } from "@aws-lambda-powertools/logger";
import { Prettify } from "../utils/UtilTypes";
import { BusinessError } from "../../layer/commons/BusinessError";
import { Errors } from "../../layer/commons/ErrorConstant";
import { HTTP_CONSTANT } from "../../layer/commons/HttpConstant";
import { AWS_REGION } from "../../layer/commons/UtilsConstans";

export type S3GetObjectInput = Prettify<GetObjectCommandInput>;
export type S3GetObjectOutput = Prettify<GetObjectCommandOutput>;

const logger = new Logger({ serviceName: "S3Util" });

export class S3Util {
    private s3Client: S3Client;

    constructor({ region = AWS_REGION }: { region?: string } = {}) {
        this.s3Client = new S3Client({ region });
    }

    public async getObject(getObjectInput: S3GetObjectInput): Promise<S3GetObjectOutput> {
        let response;
        const command = new GetObjectCommand(getObjectInput);
        try {
            response = await this.s3Client.send(command);
            return response;
        } catch (error) {
            if (error instanceof Error) {
                logger.error(error.message);
            }
            throw new BusinessError({
                code: Errors.S3.code,
                httpCode: HTTP_CONSTANT.INTERNAL_SERVER_ERROR.httpCode,
                messages: [Errors.S3.message],
            });
        }
    }
}
