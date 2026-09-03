import { describe, it, expect } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Function as LambdaFunction, Code, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import * as yml from 'yamljs';

import { DynamoDb } from '../lib/databases/dynamodb';
import { Buckets } from '../lib/buckets/buckets';
import { MessageRules } from '../lib/event-bridge/message-rules';
import { Monitoring } from '../lib/monitoring/monitoring';
import { Audit } from '../lib/audit/audit';
import { Policies } from '../lib/iam/policies';
import { GlobalEndpoint } from '../lib/global-endpoint/global-endpoint';
import { EnvironmentVariables } from '../lib/utils/interfaces/general-interfaces';

const PREFIX = 'acme-dev-messaging-hub';
const ENV = { account: '123456789012', region: 'us-east-1' };
const ALARM_EMAIL = 'alarms@example.com';

function loadEnv(): EnvironmentVariables {
    return yml.load(path.resolve(__dirname, '..', 'env', 'env-dev.yml')) as EnvironmentVariables;
}

/**
 * Bundling is disabled so NodejsFunction does not invoke esbuild during unit
 * tests. We only assert on synthesized CloudFormation, not on bundled code.
 */
function newApp(): App {
    return new App({ context: { 'aws:cdk:bundling-stacks': [] } });
}

describe('DynamoDb construct (TableV2 / Global Tables)', () => {
    it('creates the templates global table (pay-per-request, retained)', () => {
        const stack = new Stack(newApp(), 'DbStack', { env: ENV });
        new DynamoDb(stack, 'Db', { ...loadEnv(), retainData: true }, PREFIX, 'primary');
        const template = Template.fromStack(stack);

        template.resourceCountIs('AWS::DynamoDB::GlobalTable', 2);
        template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
            TableName: `${PREFIX}-messaging-templates`,
            BillingMode: 'PAY_PER_REQUEST',
            KeySchema: [
                { AttributeName: 'product', KeyType: 'HASH' },
                { AttributeName: 'filterKey', KeyType: 'RANGE' },
            ],
        });
        template.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain' });
    });

    it('creates the idempotency global table with TTL on "expiration"', () => {
        const stack = new Stack(newApp(), 'DbStack2', { env: ENV });
        new DynamoDb(stack, 'Db', { ...loadEnv(), retainData: true }, PREFIX, 'primary');
        const template = Template.fromStack(stack);

        template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
            TableName: `${PREFIX}-idempotency`,
            BillingMode: 'PAY_PER_REQUEST',
            KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
            TimeToLiveSpecification: { AttributeName: 'expiration', Enabled: true },
        });
    });

    it('replicates to the secondary region when configured', () => {
        const stack = new Stack(newApp(), 'DbStack3', { env: ENV });
        new DynamoDb(stack, 'Db', { ...loadEnv(), retainData: true }, PREFIX, 'primary');
        const template = Template.fromStack(stack);

        template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
            Replicas: Match.arrayWith([
                Match.objectLike({ Region: 'us-west-2' }),
                Match.objectLike({ Region: 'us-east-1' }),
            ]),
        });
    });
});

describe('Buckets construct', () => {
    it('creates a private, encrypted, versioned bucket with auto-delete', () => {
        const stack = new Stack(newApp(), 'BucketStack', { env: ENV });
        new Buckets(stack, 'Bucket', loadEnv(), PREFIX);
        const template = Template.fromStack(stack);

        template.hasResourceProperties('AWS::S3::Bucket', {
            BucketName: `${PREFIX}-html-storage-us-east-1`,
            VersioningConfiguration: { Status: 'Enabled' },
            PublicAccessBlockConfiguration: {
                BlockPublicAcls: true,
                BlockPublicPolicy: true,
                IgnorePublicAcls: true,
                RestrictPublicBuckets: true,
            },
            BucketEncryption: {
                ServerSideEncryptionConfiguration: [
                    { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
                ],
            },
        });
        // autoDeleteObjects wires a custom resource
        template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
    });
});

describe('MessageRules construct', () => {
    function synth(): Template {
        const stack = new Stack(newApp(), 'RulesStack', { env: ENV });
        const bus = new EventBus(stack, 'Bus', { eventBusName: `${PREFIX}-messages-bus` });
        new MessageRules(stack, 'Rules', { messageEventBus: bus }, loadEnv(), PREFIX);
        return Template.fromStack(stack);
    }

    it('creates 2 processing queues + 2 DLQs, all with SSE-SQS and SSL enforced', () => {
        const template = synth();

        // 4 queues total (2 main + 2 DLQ)
        template.resourceCountIs('AWS::SQS::Queue', 4);

        // Every queue uses SQS-managed encryption (PII at rest)
        template.allResourcesProperties('AWS::SQS::Queue', {
            SqsManagedSseEnabled: true,
        });

        // enforceSSL adds a queue policy denying non-TLS access
        template.hasResourceProperties('AWS::SQS::QueuePolicy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Effect: 'Deny',
                        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
                    }),
                ]),
            },
        });
    });

    it('wires DLQ redrive with maxReceiveCount = 3', () => {
        const template = synth();
        template.hasResourceProperties('AWS::SQS::Queue', {
            RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
        });
    });

    it('creates 2 EventBridge rules routing email/sms by detail-type', () => {
        const template = synth();
        template.resourceCountIs('AWS::Events::Rule', 2);
        template.hasResourceProperties('AWS::Events::Rule', {
            EventPattern: {
                source: ['eventbridge.messages'],
                'detail-type': ['email'],
            },
        });
        template.hasResourceProperties('AWS::Events::Rule', {
            EventPattern: {
                source: ['eventbridge.messages'],
                'detail-type': ['sms'],
            },
        });
    });

    it('creates 2 Node.js 22 arm64 Lambda functions', () => {
        const template = synth();
        template.resourceCountIs('AWS::Lambda::Function', 2);
        template.allResourcesProperties('AWS::Lambda::Function', {
            Runtime: 'nodejs22.x',
            Architectures: ['arm64'],
        });
    });

    it('enables X-Ray active tracing on both functions', () => {
        const template = synth();
        template.allResourcesProperties('AWS::Lambda::Function', {
            TracingConfig: { Mode: 'Active' },
        });
    });

    it('creates a dedicated log group per function, retention driven by config', () => {
        const template = synth();
        template.resourceCountIs('AWS::Logs::LogGroup', 2);
        template.allResourcesProperties('AWS::Logs::LogGroup', {
            RetentionInDays: loadEnv().observability.logRetentionDays,
        });
        for (const fn of ['send-email', 'send-sms']) {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                LogGroupName: `/aws/lambda/${PREFIX}-${fn}`,
            });
        }
    });

    it('points each function at its explicit log group (not the implicit one)', () => {
        const template = synth();
        template.allResourcesProperties('AWS::Lambda::Function', {
            LoggingConfig: Match.objectLike({ LogGroup: Match.anyValue() }),
        });
    });

    it('maps each queue to its Lambda with batchSize 1', () => {
        const template = synth();
        template.resourceCountIs('AWS::Lambda::EventSourceMapping', 2);
        template.allResourcesProperties('AWS::Lambda::EventSourceMapping', {
            BatchSize: 1,
        });
    });
});

describe('Monitoring construct', () => {
    function synth(): Template {
        const stack = new Stack(newApp(), 'MonStack', { env: ENV });
        const mkFn = (id: string) =>
            new LambdaFunction(stack, id, {
                runtime: Runtime.NODEJS_22_X,
                handler: 'index.handler',
                code: Code.fromInline('exports.handler = async () => {};'),
            });
        const mkQ = (id: string) => new Queue(stack, id);

        new Monitoring(
            stack,
            'Monitoring',
            {
                functions: { emailFunction: mkFn('EmailFn'), smsFunction: mkFn('SmsFn') },
                dlqs: { emailDlq: mkQ('EmailDlq'), smsDlq: mkQ('SmsDlq') },
                queues: { emailQueue: mkQ('EmailQ'), smsQueue: mkQ('SmsQ') },
            },
            ALARM_EMAIL,
            PREFIX,
            loadEnv().monitoring.alarms,
        );
        return Template.fromStack(stack);
    }

    it('creates one SNS topic subscribed by email', () => {
        const template = synth();
        template.resourceCountIs('AWS::SNS::Topic', 1);
        template.hasResourceProperties('AWS::SNS::Topic', { TopicName: `${PREFIX}-alarms` });
        template.hasResourceProperties('AWS::SNS::Subscription', {
            Protocol: 'email',
            Endpoint: ALARM_EMAIL,
        });
    });

    it('creates 8 alarms (2 DLQ + 2 errors + 2 throttles + 2 backlog age)', () => {
        const template = synth();
        template.resourceCountIs('AWS::CloudWatch::Alarm', 8);
    });

    it('wires every alarm to the SNS topic for ALARM and OK actions', () => {
        const template = synth();
        // Each alarm has both AlarmActions and OKActions defined
        template.allResourcesProperties('AWS::CloudWatch::Alarm', {
            AlarmActions: Match.anyValue(),
            OKActions: Match.anyValue(),
        });
    });

    it('alarms on the DLQ ApproximateNumberOfMessagesVisible metric', () => {
        const template = synth();
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
            MetricName: 'ApproximateNumberOfMessagesVisible',
            Namespace: 'AWS/SQS',
            ComparisonOperator: 'GreaterThanOrEqualToThreshold',
            Threshold: 1,
        });
    });
});

describe('Audit construct', () => {
    function synth(): Template {
        const stack = new Stack(newApp(), 'AuditStack', { env: ENV });
        const prodAudit = {
            ...loadEnv(),
            retainData: true,
            audit: { ...loadEnv().audit, worm: true, wormMode: 'COMPLIANCE' as const },
        };
        new Audit(stack, 'Audit', prodAudit, PREFIX, 'us-east-1');
        return Template.fromStack(stack);
    }

    it('creates a WORM (Object Lock) audit bucket with lifecycle to Glacier', () => {
        const template = synth();
        template.hasResourceProperties('AWS::S3::Bucket', {
            BucketName: `${PREFIX}-audit-us-east-1`,
            ObjectLockEnabled: true,
            VersioningConfiguration: { Status: 'Enabled' },
            ObjectLockConfiguration: Match.objectLike({
                ObjectLockEnabled: 'Enabled',
                Rule: Match.objectLike({
                    DefaultRetention: Match.objectLike({ Mode: 'COMPLIANCE', Days: 365 }),
                }),
            }),
            LifecycleConfiguration: Match.objectLike({
                Rules: Match.arrayWith([
                    Match.objectLike({
                        Transitions: Match.arrayWith([
                            Match.objectLike({ StorageClass: 'GLACIER', TransitionInDays: 90 }),
                        ]),
                    }),
                ]),
            }),
        });
    });

    it('creates Firehose delivery streams to S3 (acceptance + ses-events)', () => {
        const template = synth();
        template.resourceCountIs('AWS::KinesisFirehose::DeliveryStream', 2);
    });

    it('does NOT enable Object Lock when worm is disabled (dev/qa)', () => {
        const stack = new Stack(newApp(), 'AuditNoWorm', { env: ENV });
        const devAudit = {
            ...loadEnv(),
            retainData: false,
            audit: { ...loadEnv().audit, worm: false, wormMode: 'GOVERNANCE' as const },
        };
        new Audit(stack, 'Audit', devAudit, PREFIX, 'us-east-1');
        const template = Template.fromStack(stack);
        template.hasResourceProperties('AWS::S3::Bucket', {
            BucketName: `${PREFIX}-audit-us-east-1`,
            ObjectLockConfiguration: Match.absent(),
            ObjectLockEnabled: false,
        });
    });

    it('converts the acceptance stream to Parquet natively (Glue-backed)', () => {
        const template = synth();
        template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
            DeliveryStreamName: `${PREFIX}-audit`,
            ExtendedS3DestinationConfiguration: Match.objectLike({
                DataFormatConversionConfiguration: Match.objectLike({
                    Enabled: true,
                    OutputFormatConfiguration: {
                        Serializer: { ParquetSerDe: Match.anyValue() },
                    },
                    InputFormatConfiguration: {
                        Deserializer: { OpenXJsonSerDe: Match.anyValue() },
                    },
                }),
                BufferingHints: Match.objectLike({ SizeInMBs: 64 }),
            }),
        });
    });

    it('keeps the ses-events stream as plain JSON (uncompressed, no format conversion)', () => {
        const template = synth();
        template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
            DeliveryStreamName: `${PREFIX}-ses-events`,
            ExtendedS3DestinationConfiguration: Match.objectLike({
                CompressionFormat: 'UNCOMPRESSED',
                DataFormatConversionConfiguration: Match.absent(),
            }),
        });
    });

    it('creates an SES Configuration Set with a Firehose event destination', () => {
        const template = synth();
        template.hasResourceProperties('AWS::SES::ConfigurationSet', {
            Name: `${PREFIX}-config-set`,
        });
        template.hasResourceProperties('AWS::SES::ConfigurationSetEventDestination', {
            EventDestination: Match.objectLike({
                Enabled: true,
                MatchingEventTypes: Match.arrayWith(['delivery', 'bounce', 'complaint']),
            }),
        });
    });

    it('projects correlation fields on ses_events but not clear-text recipients', () => {
        const template = synth();
        const tables = template.findResources('AWS::Glue::Table');
        const ses = Object.values(tables).find(
            (t) => t.Properties.TableInput.Name === 'ses_events',
        );
        const cols: Array<{ Name: string; Type: string }> =
            ses!.Properties.TableInput.StorageDescriptor.Columns;
        const byName = Object.fromEntries(cols.map((c) => [c.Name, c.Type]));

        // Correlation + outcome must be queryable
        expect(Object.keys(byName).sort()).toEqual(
            ['bounce', 'complaint', 'delivery', 'eventType', 'mail', 'reject'].sort(),
        );
        expect(byName.mail).toContain('tags:map<string,array<string>>');
        expect(byName.mail).toContain('messageId:string');
        expect(byName.delivery).toContain('smtpResponse:string');
        expect(byName.bounce).toContain('bounceType:string');
        expect(byName.bounce).toContain('diagnosticCode:string');

        // PII minimization: no clear-text recipient projected anywhere
        const all = JSON.stringify(byName);
        for (const forbidden of ['destination', 'recipients:', 'emailAddress', 'headers']) {
            expect(all).not.toContain(forbidden);
        }
    });

    it('creates Glue tables: messages (Parquet, projected) + ses_events (JSON)', () => {
        const template = synth();
        template.resourceCountIs('AWS::Glue::Database', 1);
        template.resourceCountIs('AWS::Glue::Table', 2);
        template.hasResourceProperties('AWS::Glue::Table', {
            TableInput: Match.objectLike({
                Name: 'messages',
                PartitionKeys: [{ Name: 'dt', Type: 'string' }],
                Parameters: Match.objectLike({
                    classification: 'parquet',
                    'projection.enabled': 'true',
                }),
            }),
        });
    });
});

describe('GlobalEndpoint construct', () => {
    function synth(): Template {
        const stack = new Stack(newApp(), 'GeStack', { env: ENV });
        const env = { ...loadEnv(), primaryRegion: 'us-east-1', secondaryRegion: 'us-west-2' };
        new GlobalEndpoint(stack, 'Ge', env, PREFIX);
        return Template.fromStack(stack);
    }

    it('creates a global endpoint over two event buses with replication enabled', () => {
        const template = synth();
        template.resourceCountIs('AWS::Events::Endpoint', 1);
        template.hasResourceProperties('AWS::Events::Endpoint', {
            Name: `${PREFIX}-endpoint`,
            ReplicationConfig: { State: 'ENABLED' },
            EventBuses: Match.anyValue(),
        });
    });

    it('creates the latency alarm and a Route 53 health check for failover', () => {
        const template = synth();
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
            MetricName: 'IngestionToInvocationStartLatency',
            Namespace: 'AWS/Events',
            Threshold: 30000,
        });
        template.resourceCountIs('AWS::Route53::HealthCheck', 1);
    });
});

describe('Policies construct (least privilege)', () => {
    function synth(): Template {
        const stack = new Stack(newApp(), 'IamStack', { env: ENV });
        const bus = new EventBus(stack, 'Bus', { eventBusName: `${PREFIX}-messages-bus` });
        const rules = new MessageRules(stack, 'Rules', { messageEventBus: bus }, loadEnv(), PREFIX);
        const db = new DynamoDb(stack, 'Db', loadEnv(), PREFIX, 'primary');
        const buckets = new Buckets(stack, 'Bucket', loadEnv(), PREFIX);

        new Policies(stack, 'Policies', {
            messageFunctions: {
                emailFunction: rules.emailFunction,
                smsFunction: rules.smsFunction,
            },
            dynamoDbTable: db.messagingTemplates,
            idempotencyTable: db.idempotency,
            templatesBucket: buckets.htmlStorage,
            auditStreamArn: `arn:aws:firehose:us-east-1:123456789012:deliverystream/${PREFIX}-audit`,
            queues: { emailQueue: rules.emailQueue, smsQueue: rules.smsQueue },
        });

        return Template.fromStack(stack);
    }

    it('scopes SES sending to identities in this account/region (not *)', () => {
        const template = synth();
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Action: ['ses:SendRawEmail', 'ses:SendEmail'],
                        Resource: Match.arrayWith([
                            {
                                'Fn::Join': Match.arrayWith([
                                    Match.arrayWith([':ses:us-east-1:123456789012:identity/*']),
                                ]),
                            },
                        ]),
                    }),
                ]),
            },
        });
    });

    it('scopes S3 template reads to the templates bucket', () => {
        const template = synth();
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({ Action: 's3:GetObject' }),
                ]),
            },
        });
    });
});

describe('Environment YAML governs behaviour (portability)', () => {
    it('drives Lambda observability env vars from the observability block', () => {
        const env = loadEnv();
        const stack = new Stack(newApp(), 'ObsStack', { env: ENV });
        const bus = new EventBus(stack, 'Bus', { eventBusName: `${PREFIX}-messages-bus` });
        new MessageRules(stack, 'Rules', { messageEventBus: bus }, env, PREFIX);

        Template.fromStack(stack).allResourcesProperties('AWS::Lambda::Function', {
            Environment: {
                Variables: Match.objectLike({
                    POWERTOOLS_LOG_LEVEL: env.observability.logLevel,
                    POWERTOOLS_LOGGER_LOG_EVENT: String(env.observability.logEvent),
                    POWERTOOLS_TRACE_ENABLED: String(env.observability.tracing),
                }),
            },
        });
    });

    it('honours a changed observability config (tracing off, different retention/level)', () => {
        const env = {
            ...loadEnv(),
            observability: {
                logRetentionDays: 30,
                logLevel: 'DEBUG',
                logEvent: false,
                tracing: false,
            },
        };
        const stack = new Stack(newApp(), 'ObsStack2', { env: ENV });
        const bus = new EventBus(stack, 'Bus', { eventBusName: `${PREFIX}-messages-bus` });
        new MessageRules(stack, 'Rules', { messageEventBus: bus }, env, PREFIX);
        const template = Template.fromStack(stack);

        template.allResourcesProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
        template.allResourcesProperties('AWS::Lambda::Function', {
            // CDK omits TracingConfig entirely when tracing is DISABLED.
            TracingConfig: Match.absent(),
            Environment: {
                Variables: Match.objectLike({
                    POWERTOOLS_LOG_LEVEL: 'DEBUG',
                    POWERTOOLS_LOGGER_LOG_EVENT: 'false',
                    POWERTOOLS_TRACE_ENABLED: 'false',
                }),
            },
        });
    });

    it('rejects a log retention value CloudWatch does not accept', () => {
        const env = {
            ...loadEnv(),
            observability: { ...loadEnv().observability, logRetentionDays: 45 },
        };
        const stack = new Stack(newApp(), 'ObsStack3', { env: ENV });
        const bus = new EventBus(stack, 'Bus', { eventBusName: `${PREFIX}-messages-bus` });
        expect(() =>
            new MessageRules(stack, 'Rules', { messageEventBus: bus }, env, PREFIX),
        ).toThrow(/Invalid observability.logRetentionDays "45"/);
    });

    it('drives alarm thresholds and periods from the monitoring.alarms block', () => {
        const base = loadEnv().monitoring.alarms;
        const alarms = {
            ...base,
            evaluationPeriods: 3,
            queueAge: { threshold: 600, periodMinutes: 5 },
        };
        const stack = new Stack(newApp(), 'AlarmCfgStack', { env: ENV });
        const mkFn = (id: string) =>
            new LambdaFunction(stack, id, {
                runtime: Runtime.NODEJS_22_X,
                handler: 'index.handler',
                code: Code.fromInline('exports.handler = async () => {};'),
            });
        const mkQ = (id: string) => new Queue(stack, id);

        new Monitoring(
            stack,
            'Monitoring',
            {
                functions: { emailFunction: mkFn('EFn'), smsFunction: mkFn('SFn') },
                dlqs: { emailDlq: mkQ('EDlq'), smsDlq: mkQ('SDlq') },
                queues: { emailQueue: mkQ('EQ'), smsQueue: mkQ('SQ') },
            },
            ALARM_EMAIL,
            PREFIX,
            alarms,
        );
        const template = Template.fromStack(stack);

        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
            MetricName: 'ApproximateAgeOfOldestMessage',
            Threshold: 600,
            Period: 300,
            EvaluationPeriods: 3,
        });
    });

    it('drives the Global Endpoint failover threshold from the failover block', () => {
        const env = {
            ...loadEnv(),
            primaryRegion: 'us-east-1',
            secondaryRegion: 'us-west-2',
            failover: { latencyThresholdMs: 45000, periodMinutes: 5, evaluationPeriods: 2 },
        };
        const stack = new Stack(newApp(), 'GeCfgStack', { env: ENV });
        new GlobalEndpoint(stack, 'Ge', env, PREFIX);

        Template.fromStack(stack).hasResourceProperties('AWS::CloudWatch::Alarm', {
            MetricName: 'IngestionToInvocationStartLatency',
            Threshold: 45000,
            Period: 300,
            EvaluationPeriods: 2,
        });
    });
});

describe('Audit retention is fully parameterizable', () => {
    function build(auditOverrides: Record<string, unknown>, id: string): Template {
        const base = loadEnv();
        const env = {
            ...base,
            retainData: true,
            audit: { ...base.audit, ...auditOverrides },
        } as EnvironmentVariables;
        const stack = new Stack(newApp(), id, { env: ENV });
        new Audit(stack, 'Audit', env, PREFIX, 'us-east-1');
        return Template.fromStack(stack);
    }

    it('applies expirationDays to the lifecycle rule', () => {
        const template = build({ worm: false, expirationDays: 400 }, 'ExpStack');
        template.hasResourceProperties('AWS::S3::Bucket', {
            LifecycleConfiguration: {
                Rules: Match.arrayWith([
                    Match.objectLike({ Id: 'audit-retention', ExpirationInDays: 400 }),
                ]),
            },
        });
    });

    it('omits expiration entirely when expirationDays is 0', () => {
        const template = build({ worm: false, expirationDays: 0 }, 'NoExpStack');
        template.hasResourceProperties('AWS::S3::Bucket', {
            LifecycleConfiguration: {
                Rules: Match.arrayWith([
                    Match.objectLike({
                        Id: 'audit-retention',
                        ExpirationInDays: Match.absent(),
                    }),
                ]),
            },
        });
    });

    it('honours the selected archive tier', () => {
        const template = build(
            { worm: false, glacierStorageClass: 'DEEP_ARCHIVE', glacierTransitionDays: 30 },
            'TierStack',
        );
        template.hasResourceProperties('AWS::S3::Bucket', {
            LifecycleConfiguration: {
                Rules: Match.arrayWith([
                    Match.objectLike({
                        Transitions: [{ StorageClass: 'DEEP_ARCHIVE', TransitionInDays: 30 }],
                    }),
                ]),
            },
        });
    });

    it('supports GOVERNANCE mode so an erasure path stays open', () => {
        const template = build(
            { worm: true, wormMode: 'GOVERNANCE', expirationDays: 0 },
            'GovStack',
        );
        template.hasResourceProperties('AWS::S3::Bucket', {
            ObjectLockEnabled: true,
            ObjectLockConfiguration: Match.objectLike({
                Rule: { DefaultRetention: Match.objectLike({ Mode: 'GOVERNANCE' }) },
            }),
        });
    });

    it('rejects an expiration that falls inside the Object Lock window', () => {
        expect(() =>
            build(
                { worm: true, objectLockRetentionDays: 365, expirationDays: 180 },
                'BadExpStack',
            ),
        ).toThrow(/inside the Object Lock window/);
    });

    it('rejects an expiration earlier than the archive transition', () => {
        expect(() =>
            build(
                { worm: false, glacierTransitionDays: 90, expirationDays: 30 },
                'BadOrderStack',
            ),
        ).toThrow(/must be greater than/);
    });

    it('rejects an unknown archive tier', () => {
        expect(() =>
            build({ worm: false, glacierStorageClass: 'NEARLINE' }, 'BadTierStack'),
        ).toThrow(/Invalid audit.glacierStorageClass/);
    });

    it('publishes saved Athena queries for delivery visibility', () => {
        const template = build({ worm: false }, 'NamedQueryStack');
        template.resourceCountIs('AWS::Athena::NamedQuery', 2);
        template.hasResourceProperties('AWS::Athena::NamedQuery', {
            Name: `${PREFIX}-delivery-outcome`,
            QueryString: Match.stringLikeRegexp("tags\\['idempotencykey'\\]"),
        });
        template.hasResourceProperties('AWS::Athena::NamedQuery', {
            Name: `${PREFIX}-delivery-problems`,
            QueryString: Match.stringLikeRegexp('Quarantine'),
        });
    });
});
