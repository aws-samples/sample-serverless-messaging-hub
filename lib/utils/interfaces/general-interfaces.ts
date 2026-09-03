import { Construct } from 'constructs';
import { StackProps } from 'aws-cdk-lib';
import { Function } from 'aws-cdk-lib/aws-lambda';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Table, ITable } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Queue } from 'aws-cdk-lib/aws-sqs';

// ─── Shared Attributes ───

export type StackRole = 'primary' | 'secondary';

export interface StackAttributes {
    scope: Construct;
    props?: StackProps;
    environmentVariables: EnvironmentVariables;
    prefixResources: string;
    stackRole: StackRole;
}

export interface ArchitectureRootStackParams {
    scope: Construct;
    id: string;
    props?: StackProps;
    environmentVariables: EnvironmentVariables;
    prefixResources: string;
    stackRole: StackRole;
}

// ─── Environment Configuration (mirrors YAML structure) ───

export interface LambdaConfig {
    id: string;
    functionName: string;
    description: string;
    entry: string;
    timeout: number;
    memory: number;
}

export interface QueueConfig {
    name: string;
    visibilityTimeout: number;
}

export interface DlqConfig {
    name: string;
    maxReceiveCount: number;
    retentionDays: number;
}

/** A single CloudWatch alarm's tunable thresholds. */
export interface AlarmThreshold {
    threshold: number;
    periodMinutes: number;
}

export interface AlarmsConfig {
    /** Consecutive periods that must breach before the alarm fires. */
    evaluationPeriods: number;
    /** DLQ depth — any visible message means a poison/failed message. */
    dlqDepth: AlarmThreshold;
    /** Lambda `Errors` metric. */
    lambdaErrors: AlarmThreshold;
    /** Lambda `Throttles` metric. */
    lambdaThrottles: AlarmThreshold;
    /** Oldest-message age. `threshold` is in **seconds** (SQS metric unit). */
    queueAge: AlarmThreshold;
}

export interface ObservabilityConfig {
    /**
     * Lambda log group retention. Must be a value CloudWatch accepts
     * (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, ...).
     */
    logRetentionDays: number;
    /** Powertools log level: DEBUG | INFO | WARN | ERROR | CRITICAL | SILENT. */
    logLevel: string;
    /** Log the full incoming event. Verbose and costly — consider `false` in prod. */
    logEvent: boolean;
    /** X-Ray active tracing. Drives both `Tracing.ACTIVE` and POWERTOOLS_TRACE_ENABLED. */
    tracing: boolean;
}

export interface EnvironmentVariables {
    organization: string;
    appName: string;
    environment: string;
    /**
     * Optional SSM Parameter Store path holding the target AWS Account ID.
     * Defaults to `/${appName}/${environment}/account` when omitted.
     */
    account?: string;
    /**
     * Deployment region. Always overwritten per-region at synth time in `bin/cdk.ts`
     * (from `primaryRegion`/`secondaryRegion`) — the YAML value is only a fallback for
     * direct construct instantiation, e.g. in tests.
     */
    region: string;
    primaryRegion: string;
    secondaryRegion: string;
    retainData: boolean;
    tags: {
        product: string;
        owner: string;
    };
    databases: {
        dynamodb: {
            messagingTemplates: string;
            idempotency: string;
        };
    };
    eventBus: {
        rules: {
            messages: {
                source: string;
                detailType: {
                    email: string;
                    sms: string;
                };
            };
        };
    };
    buckets: {
        htmlStorage: string;
        audit: string;
    };
    monitoring: {
        alarmEmail: string;
        alarms: AlarmsConfig;
    };
    observability: ObservabilityConfig;
    /**
     * Multi-region failover trigger. Only consumed when `secondaryRegion` is set:
     * this alarm backs the Route 53 health check the Global Endpoint fails over on.
     */
    failover: {
        latencyThresholdMs: number;
        periodMinutes: number;
        evaluationPeriods: number;
    };
    audit: {
        firehoseStream: string;
        /** Enable S3 Object Lock (WORM). Create-time only; also forces versioning. */
        worm: boolean;
        /**
         * COMPLIANCE = nobody, not even root, can delete before retention expires.
         * GOVERNANCE = a principal holding `s3:BypassGovernanceRetention` can delete,
         * which keeps an erasure path open. Only meaningful when `worm: true`.
         */
        wormMode: 'COMPLIANCE' | 'GOVERNANCE';
        /** Object Lock retention window in days (only when `worm: true`). */
        objectLockRetentionDays: number;
        /** Days before transitioning audit objects to the archive storage class. */
        glacierTransitionDays: number;
        /** Archive tier for the lifecycle transition. */
        glacierStorageClass: 'GLACIER' | 'GLACIER_IR' | 'DEEP_ARCHIVE';
        /**
         * Delete audit objects after N days. `0` disables expiration (keep forever).
         * Must be >= objectLockRetentionDays when `worm: true`, otherwise S3 refuses the
         * delete and objects linger past their nominal retention.
         */
        expirationDays: number;
        bufferSeconds: number;
        bufferSizeMb: number;
    };
    sms?: {
        senderId?: string;
    };
    sqs: {
        mailing: {
            email: QueueConfig;
            sms: QueueConfig;
        };
        dlq: {
            email: DlqConfig;
            sms: DlqConfig;
        };
    };
    code: {
        lambda: {
            email: LambdaConfig;
            sms: LambdaConfig;
        };
    };
}

// ─── Nested Stack Params ───

export interface DatabaseNestedParams {
    id: string;
    stackAttributes: StackAttributes;
}

export interface BucketsNestedParams {
    id: string;
    stackAttributes: StackAttributes;
}

export interface EventsNestedParams {
    id: string;
    stackAttributes: StackAttributes;
}

export interface IamNestedParams {
    id: string;
    stackAttributes: StackAttributes;
    services: ServiceParams;
}

// ─── Monitoring ───

export interface MonitoringServiceParams {
    functions: {
        emailFunction: Function;
        smsFunction: Function;
    };
    dlqs: {
        emailDlq: Queue;
        smsDlq: Queue;
    };
    queues: {
        emailQueue: Queue;
        smsQueue: Queue;
    };
}

export interface MonitoringNestedParams {
    id: string;
    stackAttributes: StackAttributes;
    services: MonitoringServiceParams;
}

// ─── Audit ───

export interface AuditNestedParams {
    id: string;
    stackAttributes: StackAttributes;
}

// ─── Cross-Stack References ───

export interface RulesProps {
    messageEventBus: EventBus;
}

export interface ServiceParams {
    messageFunctions: {
        emailFunction: Function;
        smsFunction: Function;
    };
    dynamoDbTable: ITable;
    idempotencyTable: ITable;
    templatesBucket: Bucket;
    auditStreamArn: string;
    queues: {
        emailQueue: Queue;
        smsQueue: Queue;
    };
}
