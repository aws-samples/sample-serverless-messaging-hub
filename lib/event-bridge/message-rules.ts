import { Construct } from 'constructs';
import { Rule } from 'aws-cdk-lib/aws-events';
import { SqsQueue } from 'aws-cdk-lib/aws-events-targets';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Duration } from 'aws-cdk-lib';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Function } from 'aws-cdk-lib/aws-lambda';
import { createLambdaFunction } from '../utils/lambda-commons';
import { EnvironmentVariables, RulesProps } from '../utils/interfaces/general-interfaces';

export class MessageRules extends Construct {
    public readonly emailRule: Rule;
    public readonly smsRule: Rule;
    public readonly emailQueue: Queue;
    public readonly smsQueue: Queue;
    public readonly emailDlq: Queue;
    public readonly smsDlq: Queue;
    public readonly emailFunction: Function;
    public readonly smsFunction: Function;

    constructor(
        scope: Construct,
        id: string,
        props: RulesProps,
        environmentVariables: EnvironmentVariables,
        prefix: string,
    ) {
        super(scope, id);

        const messagesConfig = environmentVariables.eventBus.rules.messages;
        const sqsConfig = environmentVariables.sqs;
        const lambdaConfig = environmentVariables.code.lambda;

        // ─── Lambda Functions (independent, scalable individually) ───

        this.emailFunction = createLambdaFunction(this, prefix, lambdaConfig.email, environmentVariables);
        this.smsFunction = createLambdaFunction(this, prefix, lambdaConfig.sms, environmentVariables);

        // ─── Dead Letter Queues ───
        // SQS-managed SSE (SSE-SQS) is enabled on every queue: message bodies
        // carry PII (email addresses, phone numbers, names) and must be
        // encrypted at rest. SSE-SQS is chosen over SSE-KMS to avoid per-request
        // KMS costs and extra key policy management; see README "Encryption".

        this.emailDlq = new Queue(this, 'EmailDLQ', {
            queueName: `${prefix}-${sqsConfig.dlq.email.name}`,
            retentionPeriod: Duration.days(sqsConfig.dlq.email.retentionDays),
            enforceSSL: true,
            encryption: QueueEncryption.SQS_MANAGED,
        });

        this.smsDlq = new Queue(this, 'SmsDLQ', {
            queueName: `${prefix}-${sqsConfig.dlq.sms.name}`,
            retentionPeriod: Duration.days(sqsConfig.dlq.sms.retentionDays),
            enforceSSL: true,
            encryption: QueueEncryption.SQS_MANAGED,
        });

        // ─── Processing Queues (with DLQ) ───

        this.emailQueue = new Queue(this, 'EmailQueue', {
            queueName: `${prefix}-${sqsConfig.mailing.email.name}`,
            visibilityTimeout: Duration.seconds(sqsConfig.mailing.email.visibilityTimeout),
            enforceSSL: true,
            encryption: QueueEncryption.SQS_MANAGED,
            deadLetterQueue: {
                queue: this.emailDlq,
                maxReceiveCount: sqsConfig.dlq.email.maxReceiveCount,
            },
        });

        this.smsQueue = new Queue(this, 'SmsQueue', {
            queueName: `${prefix}-${sqsConfig.mailing.sms.name}`,
            visibilityTimeout: Duration.seconds(sqsConfig.mailing.sms.visibilityTimeout),
            enforceSSL: true,
            encryption: QueueEncryption.SQS_MANAGED,
            deadLetterQueue: {
                queue: this.smsDlq,
                maxReceiveCount: sqsConfig.dlq.sms.maxReceiveCount,
            },
        });

        // ─── SQS → Lambda Event Sources ───
        // batchSize is intentionally 1 and MUST NOT be changed: the handlers
        // process a single record (event.Records[0]) and rely on all-or-nothing
        // retry semantics per message. A larger batch would silently drop
        // records 1..n on this code path. See README "Batch size".

        this.emailFunction.addEventSource(new SqsEventSource(this.emailQueue, { batchSize: 1 }));
        this.smsFunction.addEventSource(new SqsEventSource(this.smsQueue, { batchSize: 1 }));

        // ─── EventBridge Rules ───

        this.emailRule = new Rule(this, 'EmailRule', {
            ruleName: `${prefix}-email-rule`,
            description: 'Route email messages from EventBridge to SQS',
            eventBus: props.messageEventBus,
            eventPattern: {
                source: [messagesConfig.source],
                detailType: [messagesConfig.detailType.email],
            },
            targets: [new SqsQueue(this.emailQueue)],
        });

        this.smsRule = new Rule(this, 'SmsRule', {
            ruleName: `${prefix}-sms-rule`,
            description: 'Route SMS messages from EventBridge to SQS',
            eventBus: props.messageEventBus,
            eventPattern: {
                source: [messagesConfig.source],
                detailType: [messagesConfig.detailType.sms],
            },
            targets: [new SqsQueue(this.smsQueue)],
        });

        // ─── Lambda Environment Variables ───

        const tableName = `${prefix}-${environmentVariables.databases.dynamodb.messagingTemplates}`;
        const bucketName = `${prefix}-${environmentVariables.buckets.htmlStorage}-${environmentVariables.region}`;
        const idempotencyTableName = `${prefix}-${environmentVariables.databases.dynamodb.idempotency}`;
        const auditStreamName = `${prefix}-${environmentVariables.audit.firehoseStream}`;

        this.emailFunction.addEnvironment('MESSAGING_TABLE_NAME', tableName);
        this.emailFunction.addEnvironment('MESSAGING_TEMPLATES_BUCKET', bucketName);
        this.emailFunction.addEnvironment('IDEMPOTENCY_TABLE_NAME', idempotencyTableName);
        this.emailFunction.addEnvironment('AUDIT_FIREHOSE_STREAM', auditStreamName);
        // SES Configuration Set for delivery/bounce/complaint event tracking (non-repudiation).
        this.emailFunction.addEnvironment('SES_CONFIGURATION_SET', `${prefix}-config-set`);

        this.smsFunction.addEnvironment('MESSAGING_TABLE_NAME', tableName);
        this.smsFunction.addEnvironment('MESSAGING_TEMPLATES_BUCKET', bucketName);
        this.smsFunction.addEnvironment('IDEMPOTENCY_TABLE_NAME', idempotencyTableName);
        this.smsFunction.addEnvironment('AUDIT_FIREHOSE_STREAM', auditStreamName);

        // Optional SMS Sender ID (region-restricted, max 11 alphanumeric chars).
        // Only injected when configured, so the SMS Lambda omits the attribute
        // where Sender ID is unsupported (e.g. US/Canada).
        const senderId = environmentVariables.sms?.senderId;
        if (senderId && senderId.trim() !== '') {
            this.smsFunction.addEnvironment('SMS_SENDER_ID', senderId);
        }
    }
}
