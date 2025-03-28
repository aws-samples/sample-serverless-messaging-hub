import {NestedStack} from "aws-cdk-lib";
import {DatabaseNestedParams} from "../utils/interfaces/general-interfaces";
import {DynamoDb} from "../databases/dynamodb";

export class DatabaseStack extends NestedStack {
    public readonly dynamoDbTables: DynamoDb;
    constructor({id, stackAttributes}: DatabaseNestedParams) {
        super(stackAttributes.scope, id, stackAttributes.props);

        this.dynamoDbTables = new DynamoDb(this, 'DynamoDbStackConstruct',
            stackAttributes.environmentVariables,
            stackAttributes.prefixResources);
    }
}
