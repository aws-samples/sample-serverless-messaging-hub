import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Architecture, Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { EnvironmentVariables, LambdaConfig } from './interfaces/general-interfaces';
import { Validation } from './validation';

/**
 * Creates a Lambda function with standardized configuration.
 * arm64 architecture for better price-performance. Node.js 22 runtime.
 *
 * Runtime/architecture/bundling are framework decisions and stay in code. Everything
 * that is an operational policy — log retention, log level, event logging, tracing —
 * comes from the environment YAML (`observability`), so each stage can be tuned
 * without code edits.
 *
 * Observability notes:
 *  • A **dedicated** CloudWatch Log Group (`/aws/lambda/<functionName>`) is created by
 *    CloudFormation instead of relying on the implicit one Lambda auto-creates on first
 *    invocation. Only an explicitly managed group can carry a retention policy and be
 *    torn down with the stack (the implicit one never expires and survives `cdk destroy`).
 *  • `Tracing.ACTIVE` enables X-Ray sampling at the Lambda service level. This is what
 *    makes the Powertools `Tracer` in the handlers actually emit segments; the
 *    POWERTOOLS_TRACE_ENABLED env var alone does nothing without active tracing, so both
 *    are driven from the single `observability.tracing` flag to keep them consistent.
 *    CDK attaches the X-Ray write permissions automatically when tracing is active.
 */
export function createLambdaFunction(
    construct: Construct,
    prefix: string,
    config: LambdaConfig,
    env: EnvironmentVariables,
): NodejsFunction {
    const functionName = `${prefix}-${config.functionName}`;
    const obs = env.observability;

    const logGroup = new LogGroup(construct, `${prefix}-${config.id}-logs`, {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: Validation.logRetention(obs.logRetentionDays),
        // Mirrors the retainData axis used for the tables and audit bucket: keep the
        // forensic trail in qa/prod, self-clean in dev.
        removalPolicy: env.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    return new NodejsFunction(construct, `${prefix}-${config.id}`, {
        functionName,
        description: config.description,
        entry: config.entry,
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: config.memory,
        timeout: Duration.seconds(config.timeout),
        tracing: obs.tracing ? Tracing.ACTIVE : Tracing.DISABLED,
        logGroup,
        environment: {
            NODE_OPTIONS: '--enable-source-maps',
            POWERTOOLS_LOG_LEVEL: obs.logLevel,
            POWERTOOLS_LOGGER_LOG_EVENT: String(obs.logEvent),
            POWERTOOLS_TRACE_ENABLED: String(obs.tracing),
        },
        bundling: {
            minify: true,
            sourceMap: true,
            target: 'es2022',
        },
    });
}
