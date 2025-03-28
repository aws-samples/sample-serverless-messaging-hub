import { Construct } from "constructs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import {
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { Duration } from "aws-cdk-lib";
import { RetentionDays } from "aws-cdk-lib/aws-logs";

export function createLambdaFunction(
  construct: Construct,
  id: string,
  functionName: string,
  description: string,
  entry: string,
  timeout: number,
  memory: number
): NodejsFunction {
  return new NodejsFunction(construct, id, {
    functionName: functionName,
    description: description,
    entry: entry,
    handler: `handler`,
    runtime: Runtime.NODEJS_20_X,
    memorySize: memory,
    timeout: Duration.seconds(timeout),
    logRetention: RetentionDays.THREE_MONTHS,
    environment: {
      LOG_LEVEL: "DEBUG",
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
      LAMBDA_INSIGHTS_LOG_LEVEL: "info",
      POWERTOOLS_LOG_LEVEL: "info",
      POWERTOOLS_LOGGER_LOG_EVENT: "true",
      POWERTOOLS_TRACE_ENABLED: "true",
    },
    bundling: {
      minify: true,
    },
  });
}
