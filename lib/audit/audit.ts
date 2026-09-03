import { Construct } from 'constructs';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import {
    BlockPublicAccess,
    Bucket,
    BucketEncryption,
    ObjectLockRetention,
    StorageClass,
} from 'aws-cdk-lib/aws-s3';
import { CfnDeliveryStream } from 'aws-cdk-lib/aws-kinesisfirehose';
import { Role, ServicePrincipal, PolicyStatement, PolicyDocument } from 'aws-cdk-lib/aws-iam';
import { CfnDatabase, CfnTable } from 'aws-cdk-lib/aws-glue';
import { CfnConfigurationSet, CfnConfigurationSetEventDestination } from 'aws-cdk-lib/aws-ses';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { CfnNamedQuery } from 'aws-cdk-lib/aws-athena';
import { EnvironmentVariables } from '../utils/interfaces/general-interfaces';
import { Validation } from '../utils/validation';

// Firehose record-format conversion requires a buffer of at least 64 MiB.
const PARQUET_MIN_BUFFER_MB = 64;

/** Archive tiers selectable via `audit.glacierStorageClass`. */
const ARCHIVE_TIERS: Record<string, StorageClass> = {
    GLACIER: StorageClass.GLACIER,
    GLACIER_IR: StorageClass.GLACIER_INSTANT_RETRIEVAL,
    DEEP_ARCHIVE: StorageClass.DEEP_ARCHIVE,
};

/**
 * Audit — durable, tamper-evident trail of every message the hub sends,
 * for non-repudiation. Two data flows land in the same WORM bucket:
 *
 *   1. Acceptance (synchronous): the Lambda writes a flat record → `audit`
 *      Firehose, which natively converts JSON → **Parquet** (columnar, cheaper
 *      Athena scans) → s3://.../data/dt=YYYY-MM-DD/ (Glue table `messages`,
 *      partition projection by date).
 *   2. Delivery (asynchronous): SES Configuration Set publishes
 *      send/delivery/bounce/complaint/reject events (carrying the idempotencyKey
 *      tag) → `ses-events` Firehose → s3://.../ses-events/ as **JSON** (Glue table
 *      `ses_events`). Kept as JSON on purpose: SES events are nested and
 *      polymorphic, and a non-repudiation record must stay complete/unaltered
 *      (a strict Parquet schema at ingest would silently drop new fields).
 *      SNS SMS delivery status is logged to CloudWatch.
 *
 * The S3 bucket always has a lifecycle transition to Glacier. Object Lock (WORM) is
 * conditional: enabled only when `audit.worm` is true (prod), in the mode set by
 * `audit.wormMode` (COMPLIANCE in prod). dev/qa capture identical records in a
 * mutable bucket. WORM is independent from `retainData` — see the bucket comment.
 */
export class Audit extends Construct {
    public readonly bucket: Bucket;
    public readonly deliveryStream: CfnDeliveryStream;
    public readonly deliveryStreamName: string;
    public readonly deliveryStreamArn: string;
    public readonly configurationSetName: string;

    constructor(scope: Construct, id: string, env: EnvironmentVariables, prefix: string, region: string) {
        super(scope, id);

        const cfg = env.audit;
        const stack = Stack.of(this);
        const databaseName = `${prefix.replace(/-/g, '_')}_audit`;

        // ─── Audit bucket ───
        // Two independent axes:
        //   • WORM (Object Lock)  → non-repudiation immutability. PROD only (env.audit.worm),
        //     mode COMPLIANCE (not even root can delete during retention) or GOVERNANCE.
        //   • retainData          → teardown/lifecycle. RETAIN (qa/prod) vs DESTROY+autoDelete (dev).
        // Object Lock can only be enabled at bucket creation and requires versioning.
        const worm = env.audit.worm;
        const retain = env.retainData;
        const lockRetention = ObjectLockRetention[
            env.audit.wormMode === 'COMPLIANCE' ? 'compliance' : 'governance'
        ](Duration.days(cfg.objectLockRetentionDays));

        // Retention is fully config-driven; validate the combination before synthesizing so
        // an impossible setup (expiry inside the lock window) fails loudly here.
        Validation.auditRetention(cfg);

        this.bucket = new Bucket(this, 'AuditBucket', {
            bucketName: `${prefix}-${env.buckets.audit}-${region}`,
            encryption: BucketEncryption.S3_MANAGED,
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            versioned: worm, // Object Lock requires versioning
            objectLockEnabled: worm,
            objectLockDefaultRetention: worm ? lockRetention : undefined,
            removalPolicy: retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
            autoDeleteObjects: !retain && !worm,
            lifecycleRules: [
                {
                    id: 'audit-retention',
                    transitions: [
                        {
                            storageClass: ARCHIVE_TIERS[cfg.glacierStorageClass],
                            transitionAfter: Duration.days(cfg.glacierTransitionDays),
                        },
                    ],
                    // 0 disables expiration (keep indefinitely).
                    expiration:
                        cfg.expirationDays > 0 ? Duration.days(cfg.expirationDays) : undefined,
                },
            ],
        });

        // ─── Firehose delivery role (write to S3 + read Glue schema for Parquet) ───
        const firehoseRole = new Role(this, 'FirehoseRole', {
            assumedBy: new ServicePrincipal('firehose.amazonaws.com'),
        });
        this.bucket.grantReadWrite(firehoseRole);
        firehoseRole.addToPolicy(
            new PolicyStatement({
                actions: ['glue:GetTable', 'glue:GetTableVersion', 'glue:GetTableVersions'],
                resources: [
                    stack.formatArn({ service: 'glue', resource: 'catalog' }),
                    stack.formatArn({ service: 'glue', resource: 'database', resourceName: databaseName }),
                    stack.formatArn({ service: 'glue', resource: 'table', resourceName: `${databaseName}/*` }),
                ],
            }),
        );

        // ─── Glue catalog ───
        const glueDb = new CfnDatabase(this, 'AuditGlueDb', {
            catalogId: stack.account,
            databaseInput: { name: databaseName },
        });

        // Acceptance table — Parquet, partitioned by date (partition projection).
        const messagesColumns = [
            'idempotencyKey',
            'product',
            'channel',
            'feature',
            'language',
            'recipientHash',
            'status',
            'providerMessageId',
            'region',
            'timestamp',
        ].map((name) => ({ name, type: 'string' }));

        const messagesTable = new CfnTable(this, 'AuditGlueTable', {
            catalogId: stack.account,
            databaseName,
            tableInput: {
                name: 'messages',
                tableType: 'EXTERNAL_TABLE',
                partitionKeys: [{ name: 'dt', type: 'string' }],
                parameters: {
                    classification: 'parquet',
                    // Athena partition projection — no MSCK/crawler needed.
                    'projection.enabled': 'true',
                    'projection.dt.type': 'date',
                    'projection.dt.format': 'yyyy-MM-dd',
                    'projection.dt.range': 'NOW-3YEARS,NOW',
                    'projection.dt.interval': '1',
                    'projection.dt.interval.unit': 'DAYS',
                    'storage.location.template': `s3://${this.bucket.bucketName}/data/dt=\${dt}/`,
                },
                storageDescriptor: {
                    columns: messagesColumns,
                    location: `s3://${this.bucket.bucketName}/data/`,
                    inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
                    outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
                    serdeInfo: {
                        serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
                    },
                },
            },
        });
        messagesTable.addDependency(glueDb);

        // ─── (1) Acceptance stream — DirectPut, JSON → Parquet conversion ───
        this.deliveryStreamName = `${prefix}-${cfg.firehoseStream}`;
        this.deliveryStream = new CfnDeliveryStream(this, 'AuditFirehose', {
            deliveryStreamName: this.deliveryStreamName,
            deliveryStreamType: 'DirectPut',
            extendedS3DestinationConfiguration: {
                bucketArn: this.bucket.bucketArn,
                roleArn: firehoseRole.roleArn,
                compressionFormat: 'UNCOMPRESSED', // Parquet applies its own (Snappy)
                prefix: 'data/dt=!{timestamp:yyyy-MM-dd}/',
                errorOutputPrefix: 'errors/data/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/',
                bufferingHints: {
                    intervalInSeconds: cfg.bufferSeconds,
                    // Record-format conversion requires >= 64 MiB.
                    sizeInMBs: Math.max(cfg.bufferSizeMb, PARQUET_MIN_BUFFER_MB),
                },
                dataFormatConversionConfiguration: {
                    enabled: true,
                    inputFormatConfiguration: { deserializer: { openXJsonSerDe: {} } },
                    outputFormatConfiguration: { serializer: { parquetSerDe: {} } },
                    schemaConfiguration: {
                        catalogId: stack.account,
                        databaseName,
                        tableName: 'messages',
                        roleArn: firehoseRole.roleArn,
                        region: stack.region,
                        versionId: 'LATEST',
                    },
                },
            },
        });
        this.deliveryStream.node.addDependency(firehoseRole);
        this.deliveryStream.node.addDependency(messagesTable);
        this.deliveryStreamArn = stack.formatArn({
            service: 'firehose',
            resource: 'deliverystream',
            resourceName: this.deliveryStreamName,
        });

        // ─── (2) SES delivery-events stream — plain JSON Lines (raw, human-readable) ───
        // Kept UNCOMPRESSED on purpose: this is a low-volume forensic/non-repudiation
        // store that is inspected directly. GZIP output carries a `Content-Encoding: gzip`
        // header that makes content-encoding-aware clients (S3 console, browsers, curl
        // --compressed) transparently decompress on download, leaving plain JSON in a
        // `.gz`-named file (so `gzip -d` fails). Plain JSON Lines avoids that trap; Athena
        // still reads it via the `ses_events` Glue table.
        const sesEventsStreamName = `${prefix}-ses-events`;
        const sesEventsStream = new CfnDeliveryStream(this, 'SesEventsFirehose', {
            deliveryStreamName: sesEventsStreamName,
            deliveryStreamType: 'DirectPut',
            extendedS3DestinationConfiguration: {
                bucketArn: this.bucket.bucketArn,
                roleArn: firehoseRole.roleArn,
                compressionFormat: 'UNCOMPRESSED',
                prefix: 'ses-events/!{timestamp:yyyy/MM/dd}/',
                errorOutputPrefix: 'errors/ses-events/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/',
                bufferingHints: {
                    intervalInSeconds: cfg.bufferSeconds,
                    sizeInMBs: cfg.bufferSizeMb,
                },
            },
        });
        sesEventsStream.node.addDependency(firehoseRole);

        // Role SES assumes to put records into the ses-events stream.
        // Inline policy (baked into the role) + explicit dependency so SES sees the
        // permission when it validates access at event-destination creation.
        const sesToFirehoseRole = new Role(this, 'SesToFirehoseRole', {
            assumedBy: new ServicePrincipal('ses.amazonaws.com'),
            inlinePolicies: {
                firehose: new PolicyDocument({
                    statements: [
                        new PolicyStatement({
                            actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
                            resources: [sesEventsStream.attrArn],
                        }),
                    ],
                }),
            },
        });

        // ─── SES Configuration Set + event destination (non-repudiation) ───
        this.configurationSetName = `${prefix}-config-set`;
        const configSet = new CfnConfigurationSet(this, 'SesConfigSet', {
            name: this.configurationSetName,
        });
        const sesEventDestination = new CfnConfigurationSetEventDestination(this, 'SesEventDestination', {
            configurationSetName: this.configurationSetName,
            eventDestination: {
                enabled: true,
                matchingEventTypes: ['send', 'delivery', 'bounce', 'complaint', 'reject'],
                kinesisFirehoseDestination: {
                    deliveryStreamArn: sesEventsStream.attrArn,
                    iamRoleArn: sesToFirehoseRole.roleArn,
                },
            },
        });
        sesEventDestination.addDependency(configSet);
        sesEventDestination.node.addDependency(sesToFirehoseRole);

        // ses_events table — JSON (nested/polymorphic).
        //
        // The stored object always keeps the SES payload verbatim; this schema only
        // controls what Athena can *project*. Two deliberate choices:
        //
        //  • Correlation + outcome fields ARE projected, so a delivery/bounce can be
        //    joined to an acceptance record: `mail.tags['idempotencyKey']` matches
        //    `messages.idempotencykey`. Without these columns the table is limited to
        //    counting event types, which defeats the purpose of the trail.
        //  • Clear-text recipient fields (`mail.destination`, `delivery.recipients`,
        //    `mail.headers`, `commonHeaders.to`) are deliberately NOT projected, to keep
        //    the query surface PII-minimized and consistent with hashing the recipient in
        //    the `messages` stream. To identify who bounced, join on idempotencyKey and
        //    compare `messages.recipienthash`. NOTE: those fields still exist in the S3
        //    object — see docs/compliance.md, "PII in the SES delivery events".
        //
        // The OpenX JSON SerDe ignores undeclared fields, so new SES fields keep landing
        // in S3 untouched and can be exposed later by adding columns here.
        const sesEventsTable = new CfnTable(this, 'SesEventsGlueTable', {
            catalogId: stack.account,
            databaseName,
            tableInput: {
                name: 'ses_events',
                tableType: 'EXTERNAL_TABLE',
                parameters: { classification: 'json' },
                storageDescriptor: {
                    columns: [
                        { name: 'eventType', type: 'string' },
                        {
                            name: 'mail',
                            type:
                                'struct<' +
                                'timestamp:string,' +
                                'source:string,' +
                                'sourceArn:string,' +
                                'sendingAccountId:string,' +
                                'messageId:string,' +
                                'commonHeaders:struct<subject:string>,' +
                                'tags:map<string,array<string>>' +
                                '>',
                        },
                        {
                            name: 'delivery',
                            type:
                                'struct<' +
                                'timestamp:string,' +
                                'processingTimeMillis:bigint,' +
                                'smtpResponse:string,' +
                                'remoteMtaIp:string,' +
                                'reportingMTA:string' +
                                '>',
                        },
                        {
                            name: 'bounce',
                            type:
                                'struct<' +
                                'bounceType:string,' +
                                'bounceSubType:string,' +
                                'timestamp:string,' +
                                'feedbackId:string,' +
                                'reportingMTA:string,' +
                                'bouncedRecipients:array<struct<action:string,status:string,diagnosticCode:string>>' +
                                '>',
                        },
                        {
                            name: 'complaint',
                            type:
                                'struct<' +
                                'timestamp:string,' +
                                'feedbackId:string,' +
                                'complaintFeedbackType:string,' +
                                'complaintSubType:string,' +
                                'userAgent:string' +
                                '>',
                        },
                        { name: 'reject', type: 'struct<reason:string>' },
                    ],
                    location: `s3://${this.bucket.bucketName}/ses-events/`,
                    inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
                    outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
                    serdeInfo: { serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe' },
                },
            },
        });
        sesEventsTable.addDependency(glueDb);

        // ─── Saved Athena queries — delivery visibility without writing SQL ───
        // Acceptance proves AWS took the message; only these delivery events prove what the
        // receiving provider did with it (inbox, spam/quarantine, or rejection). NOTE: the
        // OpenX SerDe lower-cases map keys, hence `tags['idempotencykey']`.
        const deliveryOutcomeSql = [
            '-- Acceptance joined to the real provider outcome, per message.',
            '-- `outcome` NULL means SES accepted it but no delivery event has arrived yet.',
            'WITH ev AS (',
            "    SELECT mail.tags['idempotencykey'][1] AS k,",
            '           eventtype,',
            '           delivery.smtpresponse AS smtp,',
            '           bounce.bouncetype     AS btype,',
            '           bounce.bouncedrecipients[1].diagnosticcode AS diag',
            '    FROM ses_events',
            ')',
            'SELECT m.dt,',
            '       m.idempotencykey,',
            '       m.product, m.feature, m.language,',
            '       m.status AS accepted,',
            '       m.recipienthash,',
            '       m.providermessageid,',
            "       max(CASE WHEN ev.eventtype = 'Delivery' THEN 'DELIVERED'",
            "                WHEN ev.eventtype = 'Bounce'   THEN 'BOUNCED'",
            "                WHEN ev.eventtype = 'Complaint' THEN 'COMPLAINT'",
            "                WHEN ev.eventtype = 'Reject'   THEN 'REJECTED' END) AS outcome,",
            '       max(coalesce(ev.smtp, ev.diag)) AS provider_response,',
            '       max(ev.btype) AS bounce_type',
            'FROM messages m',
            'LEFT JOIN ev ON ev.k = m.idempotencykey',
            'GROUP BY m.dt, m.idempotencykey, m.product, m.feature, m.language,',
            '         m.status, m.recipienthash, m.providermessageid',
            'ORDER BY m.dt DESC, m.idempotencykey;',
        ].join('\n');

        new CfnNamedQuery(this, 'DeliveryOutcomeQuery', {
            name: `${prefix}-delivery-outcome`,
            database: databaseName,
            description:
                'Per-message acceptance vs real provider outcome (delivered / bounced / complaint / rejected).',
            queryString: deliveryOutcomeSql,
        }).addDependency(messagesTable);

        // Spam/quarantine is invisible in the bounce type — it only shows in the SMTP text,
        // so surface it explicitly alongside hard failures.
        const problemsSql = [
            '-- Messages the receiving provider did NOT put in the inbox.',
            '-- Covers hard failures (bounce/complaint/reject) AND silent spam filtering,',
            '-- which appears as a 250 OK carrying DMARC/spam markers.',
            'SELECT eventtype,',
            "       mail.tags['idempotencykey'][1] AS idempotency_key,",
            '       mail.messageid,',
            '       mail.commonheaders.subject,',
            '       bounce.bouncetype,',
            '       bounce.bouncedrecipients[1].diagnosticcode AS diagnostic,',
            '       delivery.smtpresponse',
            'FROM ses_events',
            "WHERE eventtype IN ('Bounce', 'Complaint', 'Reject')",
            "   OR delivery.smtpresponse LIKE '%Quarantine%'",
            "   OR delivery.smtpresponse LIKE '%spam%'",
            'ORDER BY mail.timestamp DESC;',
        ].join('\n');

        new CfnNamedQuery(this, 'DeliveryProblemsQuery', {
            name: `${prefix}-delivery-problems`,
            database: databaseName,
            description:
                'Bounces, complaints, rejections and silently spam-filtered/quarantined messages.',
            queryString: problemsSql,
        }).addDependency(sesEventsTable);

        // ─── SNS SMS delivery status logging (account/region-level) ───
        // NOTE: SetSMSAttributes is an ACCOUNT+REGION-level setting; it affects all
        // SMS sent from this account/region, not just this app.
        const snsSmsLogsRole = new Role(this, 'SnsSmsLogsRole', {
            assumedBy: new ServicePrincipal('sns.amazonaws.com'),
        });
        snsSmsLogsRole.addToPolicy(
            new PolicyStatement({
                actions: [
                    'logs:CreateLogGroup',
                    'logs:CreateLogStream',
                    'logs:PutLogEvents',
                    'logs:PutMetricFilter',
                    'logs:PutRetentionPolicy',
                ],
                resources: ['*'],
            }),
        );
        new AwsCustomResource(this, 'SnsSmsDeliveryStatus', {
            onUpdate: {
                service: 'SNS',
                action: 'setSMSAttributes',
                parameters: {
                    attributes: {
                        DeliveryStatusIAMRole: snsSmsLogsRole.roleArn,
                        DeliveryStatusSuccessSamplingRate: '100',
                    },
                },
                physicalResourceId: PhysicalResourceId.of(`${prefix}-sns-sms-delivery-status`),
            },
            // Needs sns:SetSMSAttributes AND iam:PassRole for the delivery-status role.
            policy: AwsCustomResourcePolicy.fromStatements([
                new PolicyStatement({
                    actions: ['sns:SetSMSAttributes'],
                    resources: ['*'],
                }),
                new PolicyStatement({
                    actions: ['iam:PassRole'],
                    resources: [snsSmsLogsRole.roleArn],
                }),
            ]),
        });
    }
}
