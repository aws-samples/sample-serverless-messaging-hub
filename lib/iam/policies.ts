import { Construct } from 'constructs';
import { Stack } from 'aws-cdk-lib';
import { Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { ServiceParams } from '../utils/interfaces/general-interfaces';

/**
 * IAM policies scoped to specific resource ARNs (least privilege).
 *
 * Scoping notes:
 *  • **SES** supports resource-level permissions on identity ARNs, so sending is
 *    restricted to identities verified in *this* account+region (plus the app's own
 *    configuration set). The sender address itself comes from the DynamoDB template
 *    item at runtime, so it cannot be pinned at synth time — `identity/*` is the
 *    tightest static scope available.
 *  • **SNS** direct-to-phone publishing (`PhoneNumber`, no topic) has no resource ARN
 *    to scope against, so `sns:Publish` must stay on `*`. This is an SNS API
 *    constraint, not an oversight.
 */
export class Policies extends Construct {
    constructor(scope: Construct, id: string, props: ServiceParams) {
        super(scope, id);

        const stack = Stack.of(this);
        const bucketArn = props.templatesBucket.bucketArn;

        // SES identities + the app's configuration set, in this account/region only.
        const sesResources = [
            stack.formatArn({ service: 'ses', resource: 'identity', resourceName: '*' }),
            stack.formatArn({ service: 'ses', resource: 'configuration-set', resourceName: '*' }),
        ];

        // ─── Email Lambda: SES send + S3 read templates + DynamoDB read ───

        props.messageFunctions.emailFunction.role?.attachInlinePolicy(
            new Policy(this, 'EmailFunctionPolicy', {
                statements: [
                    new PolicyStatement({
                        actions: ['ses:SendRawEmail', 'ses:SendEmail'],
                        resources: sesResources,
                    }),
                    new PolicyStatement({
                        actions: ['s3:GetObject'],
                        resources: [`${bucketArn}/*`],
                    }),
                ],
            }),
        );

        // ─── SMS Lambda: SNS publish + S3 read templates + DynamoDB read ───

        props.messageFunctions.smsFunction.role?.attachInlinePolicy(
            new Policy(this, 'SmsFunctionPolicy', {
                statements: [
                    new PolicyStatement({
                        // Direct SMS publish targets a PhoneNumber, not a topic ARN:
                        // SNS offers no resource to scope this to. See class doc.
                        actions: ['sns:Publish'],
                        resources: ['*'],
                    }),
                    new PolicyStatement({
                        actions: ['s3:GetObject'],
                        resources: [`${bucketArn}/*`],
                    }),
                ],
            }),
        );

        // ─── DynamoDB read access (scoped via CDK grant) ───

        props.dynamoDbTable.grantReadData(props.messageFunctions.emailFunction);
        props.dynamoDbTable.grantReadData(props.messageFunctions.smsFunction);

        // ─── Idempotency table: read/write (Powertools needs Get/Put/Update/Delete) ───

        props.idempotencyTable.grantReadWriteData(props.messageFunctions.emailFunction);
        props.idempotencyTable.grantReadWriteData(props.messageFunctions.smsFunction);

        // ─── Audit: write acceptance records to the Firehose delivery stream ───

        const firehosePolicy = new Policy(this, 'AuditFirehosePolicy', {
            statements: [
                new PolicyStatement({
                    actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
                    resources: [props.auditStreamArn],
                }),
            ],
        });
        props.messageFunctions.emailFunction.role?.attachInlinePolicy(firehosePolicy);
        props.messageFunctions.smsFunction.role?.attachInlinePolicy(firehosePolicy);
    }
}
