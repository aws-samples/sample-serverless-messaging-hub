import { Stack } from 'aws-cdk-lib';
import { ArchitectureRootStackParams, StackAttributes } from './utils/interfaces/general-interfaces';
import { DatabaseStack } from './nested/database-stack';
import { BucketsStack } from './nested/buckets-stack';
import { EventsStack } from './nested/events-stack';
import { IamStack } from './nested/iam-stack';
import { AuditStack } from './nested/audit-stack';
import { MonitoringStack } from './nested/monitoring-stack';

/**
 * ArchitectureStack — Root stack orchestrator.
 *
 * Composes all nested stacks in dependency order and wires
 * cross-stack references through constructor props.
 */
export class ArchitectureStack extends Stack {
    constructor({ scope, id, props, environmentVariables, prefixResources, stackRole }: ArchitectureRootStackParams) {
        super(scope, id, props);

        const stackAttributes: StackAttributes = {
            props,
            environmentVariables,
            prefixResources,
            scope: this,
            stackRole,
        };

        // ─── 1. Database — DynamoDB (messaging templates) ───
        const databaseStack = new DatabaseStack({
            stackAttributes,
            id: 'DatabaseNestedStackConstruct',
        });

        // ─── 2. Buckets — S3 (HTML templates storage) ───
        const bucketsStack = new BucketsStack({
            stackAttributes,
            id: 'BucketsNestedStackConstruct',
        });

        // ─── 3. Events — EventBridge + SQS + Lambda (email & SMS) ───
        const eventsStack = new EventsStack({
            stackAttributes,
            id: 'EventsNestedStackConstruct',
        });

        // ─── 4. Audit — S3 (WORM) + Firehose + Glue (non-repudiation trail) ───
        const auditStack = new AuditStack({
            stackAttributes,
            id: 'AuditNestedStackConstruct',
        });

        // ─── 5. IAM — Scoped policies for Lambda functions ───
        const iamStack = new IamStack({
            stackAttributes,
            id: 'IamNestedStackConstruct',
            services: {
                messageFunctions: {
                    emailFunction: eventsStack.messagesRules.emailFunction,
                    smsFunction: eventsStack.messagesRules.smsFunction,
                },
                dynamoDbTable: databaseStack.dynamoDbTables.messagingTemplates,
                idempotencyTable: databaseStack.dynamoDbTables.idempotency,
                templatesBucket: bucketsStack.storage.htmlStorage,
                auditStreamArn: auditStack.audit.deliveryStreamArn,
                queues: {
                    emailQueue: eventsStack.messagesRules.emailQueue,
                    smsQueue: eventsStack.messagesRules.smsQueue,
                },
            },
        });
        iamStack.node.addDependency(databaseStack);
        iamStack.node.addDependency(bucketsStack);
        iamStack.node.addDependency(eventsStack);
        iamStack.node.addDependency(auditStack);

        // ─── 6. Monitoring — SNS topic + CloudWatch alarms (DLQ, Lambda, backlog) ───
        const monitoringStack = new MonitoringStack({
            stackAttributes,
            id: 'MonitoringNestedStackConstruct',
            services: {
                functions: {
                    emailFunction: eventsStack.messagesRules.emailFunction,
                    smsFunction: eventsStack.messagesRules.smsFunction,
                },
                dlqs: {
                    emailDlq: eventsStack.messagesRules.emailDlq,
                    smsDlq: eventsStack.messagesRules.smsDlq,
                },
                queues: {
                    emailQueue: eventsStack.messagesRules.emailQueue,
                    smsQueue: eventsStack.messagesRules.smsQueue,
                },
            },
        });
        monitoringStack.node.addDependency(eventsStack);
    }
}
