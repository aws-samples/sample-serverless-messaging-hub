import {NestedStack} from "aws-cdk-lib";
import {BusesNestedParams} from "../utils/interfaces/general-interfaces";
import {Buses} from "../event-bridge/buses";
import {MessageRules} from "../event-bridge/message-rules";

export class EventsStack extends NestedStack {
    public readonly buses: Buses;
    public readonly messagesRules: MessageRules;

    constructor({id, stackAttributes}: BusesNestedParams) {
        super(stackAttributes.scope, id, stackAttributes.props);

        this.buses = new Buses(this, 'BusesStackConstruct',
            stackAttributes.environmentVariables,
            stackAttributes.prefixResources);

        this.messagesRules = new MessageRules(this, 'MessagesRulesStackConstruct',
            {
                messageEventBus: this.buses.messagesEventBus
            },
            stackAttributes.environmentVariables,
            stackAttributes.prefixResources);
        this.messagesRules.node.addDependency(this.buses);
    }
}
