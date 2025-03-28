import {Stack} from "aws-cdk-lib";
import {
    ArchitectureRootStackParams,
    StackAttributes,
} from "./utils/interfaces/general-interfaces";
import {DatabaseStack} from "./nested/database-stack";
import {BucketsStack} from "./nested/buckets-stack";
import {EventsStack} from "./nested/events-stack";
import { IamStack } from "./nested/iam-stack";

export class ArchitectureStack extends Stack {
    constructor({
                    scope,
                    id,
                    props,
                    environmentVariables,
                    prefixResources,
                }: ArchitectureRootStackParams) {
        super(scope, id, props);
        const stackAttributes: StackAttributes = {
            props: props,
            environmentVariables: environmentVariables,
            prefixResources: prefixResources,
            scope: this,
        };

        const bucketStack = new BucketsStack({
            stackAttributes: stackAttributes,
            id: "BucketsNestedStackConstruct",
        });
        const databaseStack = new DatabaseStack({
            stackAttributes: stackAttributes,
            id: "DatabasesNestedStackConstruct",
        });

        const busesStack = new EventsStack({
            stackAttributes: stackAttributes,
            id: "BusesNestedStackConstruct",
        });

        const iamStack = new IamStack({
            stackAttributes: stackAttributes,
            id: "IamNestedStackConstruct",
            services: {
                messageFunctionsParams: {
                    pushEmailFunction: busesStack.messagesRules.pushEmailFunction,
                    pushSMSFunction: busesStack.messagesRules.pushSMSFunction,
                },
                dynamoDbTables: databaseStack.dynamoDbTables,
                messageEventBus: busesStack.buses.messagesEventBus
            },
        });
        iamStack.node.addDependency(databaseStack);
        iamStack.node.addDependency(busesStack);
        iamStack.node.addDependency(bucketStack);

    }
}
