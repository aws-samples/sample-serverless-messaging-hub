import {Construct} from "constructs";
import {RemovalPolicy} from "aws-cdk-lib";
import {AttributeType, BillingMode, StreamViewType, Table, TableEncryption} from "aws-cdk-lib/aws-dynamodb";

export class DynamoDb extends Construct {

  public readonly messagingTemplates: Table;
  constructor(scope: Construct, id: string, environmentVariables: any, prefix: string) {
    super(scope, id);

    this.messagingTemplates = new Table(this, "EnrollmentProcess", {
      tableName: `${prefix}-${environmentVariables.databases.dynamo.messaging}`,
      partitionKey: { name: "product", type: AttributeType.STRING },
      sortKey: { name: "filterKey", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.DEFAULT,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      stream: StreamViewType.NEW_IMAGE
    });
  }
}
