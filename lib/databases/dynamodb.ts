import { Construct } from 'constructs';
import { RemovalPolicy } from 'aws-cdk-lib';
import {
    AttributeType,
    Billing,
    ITable,
    MultiRegionConsistency,
    StreamViewType,
    Table,
    TableV2,
} from 'aws-cdk-lib/aws-dynamodb';
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
        //
        // Multi-region uses **MRSC** (Multi-Region Strong Consistency): conditional writes
        // are evaluated against the latest version of the item across Regions. That is the
        // property the dedup guard depends on. With an eventually consistent global table
        // both Regions' `attribute_not_exists(id)` claims succeed inside the replication
        // lag and the message is sent twice — measured, not hypothetical.
        //
        // Trade-off: **MRSC does not support TTL**, so records are never physically
        // deleted. Correctness is unaffected (the dedup window is enforced by the
        // `#expiry < :now` branch of the conditional write, not by TTL); storage grows
        // unbounded. Single-region deployments keep TTL, since there is no cross-region
        // race to protect against.
        const witnessRegion = replicas ? env.databases.dynamodb.idempotencyWitnessRegion : undefined;
        const useMrsc = Boolean(witnessRegion);

        this.idempotency = new TableV2(this, 'Idempotency', {
            tableName: idempotencyName,
            partitionKey: { name: 'id', type: AttributeType.STRING },
            billing: Billing.onDemand(),
            ...(useMrsc
                ? {
                      multiRegionConsistency: MultiRegionConsistency.STRONG,
                      witnessRegion,
                  }
                : { timeToLiveAttribute: 'expiration' }),
            removalPolicy: RemovalPolicy.DESTROY,
            replicas,
        });
    }
}
