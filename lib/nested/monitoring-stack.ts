import { NestedStack } from 'aws-cdk-lib';
import { MonitoringNestedParams } from '../utils/interfaces/general-interfaces';
import { Monitoring } from '../monitoring/monitoring';

export class MonitoringStack extends NestedStack {
    public readonly monitoring: Monitoring;

    constructor({ id, stackAttributes, services }: MonitoringNestedParams) {
        super(stackAttributes.scope, id, stackAttributes.props);

        this.monitoring = new Monitoring(
            this,
            'MonitoringConstruct',
            services,
            stackAttributes.environmentVariables.monitoring.alarmEmail,
            stackAttributes.prefixResources,
            stackAttributes.environmentVariables.monitoring.alarms,
        );
    }
}
