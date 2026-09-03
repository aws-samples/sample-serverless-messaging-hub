import { NestedStack } from 'aws-cdk-lib';
import { EventsNestedParams } from '../utils/interfaces/general-interfaces';
import { Buses } from '../event-bridge/buses';
import { MessageRules } from '../event-bridge/message-rules';

export class EventsStack extends NestedStack {
    public readonly buses: Buses;
    public readonly messagesRules: MessageRules;

    constructor({ id, stackAttributes }: EventsNestedParams) {
        super(stackAttributes.scope, id, stackAttributes.props);

        this.buses = new Buses(this, 'BusesConstruct', stackAttributes.prefixResources);

        this.messagesRules = new MessageRules(
            this,
            'MessageRulesConstruct',
            { messageEventBus: this.buses.messagesEventBus },
            stackAttributes.environmentVariables,
            stackAttributes.prefixResources,
        );
        this.messagesRules.node.addDependency(this.buses);
    }
}
