import {Construct} from 'constructs';
import {EventBus} from "aws-cdk-lib/aws-events";

export class Buses extends Construct {
    public readonly messagesEventBus: EventBus;

    constructor(scope: Construct, id: string, environmentVariables: any, prefix: string) {
        super(scope, id);
        this.messagesEventBus = new EventBus(this, 'MessagesEventBus', {
            eventBusName: `${prefix}-messages-bus`
        });
    }
}
