import { Construct } from 'constructs';
import { RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, Billing, ITable, StreamViewType, Table, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { EnvironmentVariables, StackRole } from '../utils/interfaces/general-interfaces';

/**
 * DynamoDB tables using TableV2 (native Global Tables — CloudFormation manages
 * replicas, no cross-region custom-resource Lambda).
 *
 * Multi-region: when `secondaryRegion` is configured, the PRIMARY stack defines
 * both tables with a replica in the secondary region. The SECONDARY stack does
 * NOT redefine them — it imports the replicas by name so Lambdas/IAM can use them.
 */
export class DynamoDb extends Construct {
    public readonly messagingTemplates: ITable;
    public readonly idempotency: ITable;

    constructor(
        scope: Construct,
        id: string,
        env: EnvironmentVariables,
        prefix: string,
        stackRole: StackRole,
    ) {
        super(scope, id);

        const templatesName = `${prefix}-${env.databases.dynamodb.messagingTemplates}`;
        const idempotencyName = `${prefix}-${env.databases.dynamodb.idempotency}`;

        const replicas =
            env.secondaryRegion && env.secondaryRegion !== env.primaryRegion
                ? [{ region: env.secondaryRegion }]
                : undefined;

        // Secondary region: tables are Global Table replicas managed by the
        // primary stack. Import them by name (no resource creation here).
        if (stackRole === 'secondary') {
            this.messagingTemplates = Table.fromTableName(this, 'MessagingTemplates', templatesName);
            this.idempotency = Table.fromTableName(this, 'Idempotency', idempotencyName);
            return;
        }

        this.messagingTemplates = new TableV2(this, 'MessagingTemplates', {
            tableName: templatesName,
            partitionKey: { name: 'product', type: AttributeType.STRING },
            sortKey: { name: 'filterKey', type: AttributeType.STRING },
            billing: Billing.onDemand(),
            dynamoStream: StreamViewType.NEW_AND_OLD_IMAGES,
            deletionProtection: env.retainData,
            removalPolicy: env.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
            replicas,
        });

        // ─── Idempotency store (Powertools Idempotency) ───
        // TTL ('expiration') auto-expires records after the per-template window
        // (default 1 day). As a Global Table it is eventually consistent across
        // regions (small duplicate window possible during failover — documented).
        this.idempotency = new TableV2(this, 'Idempotency', {
            tableName: idempotencyName,
            partitionKey: { name: 'id', type: AttributeType.STRING },
            billing: Billing.onDemand(),
            timeToLiveAttribute: 'expiration',
            removalPolicy: RemovalPolicy.DESTROY,
            replicas,
        });
    }
}
