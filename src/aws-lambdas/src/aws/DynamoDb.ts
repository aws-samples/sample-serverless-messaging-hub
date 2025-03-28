import {
    DynamoDBClient,
    GetItemCommand,
    GetItemInput,
    GetItemOutput,
} from "@aws-sdk/client-dynamodb";
import { Logger } from "@aws-lambda-powertools/logger";
import { Prettify } from "../utils/UtilTypes";
import { BusinessError } from "../../layer/commons/BusinessError";
import { Errors } from "../../layer/commons/ErrorConstant";
import { HTTP_CONSTANT } from "../../layer/commons/HttpConstant";
import { AWS_REGION } from "../../layer/commons/UtilsConstans";

export type DynamoDBGetItemInput = Prettify<GetItemInput>;
export type DynamoDBGetItemOutput = Prettify<GetItemOutput>;

const logger = new Logger({ serviceName: "DynamoDBUtil" });

export class DynamoDbUtil {
    private dynamoDBClient: DynamoDBClient;

    constructor({ region = AWS_REGION }: { region?: string } = {}) {
        this.dynamoDBClient = new DynamoDBClient({ region });
    }

    public async getItem(getItemInput: DynamoDBGetItemInput): Promise<DynamoDBGetItemOutput> {
        let response;
        const command = new GetItemCommand(getItemInput);
        try {
            response = await this.dynamoDBClient.send(command);
            return response;
        } catch (error) {
            if (error instanceof Error) {
                logger.error(error.message);
            }
            throw new BusinessError({
                code: Errors.DATABASE.code,
                httpCode: HTTP_CONSTANT.INTERNAL_SERVER_ERROR.httpCode,
                messages: [Errors.DATABASE.message],
            });
        }
    }
}
