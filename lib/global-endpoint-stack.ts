import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { GlobalEndpoint } from './global-endpoint/global-endpoint';
import { EnvironmentVariables } from './utils/interfaces/general-interfaces';

export interface GlobalEndpointStackParams {
    scope: Construct;
    id: string;
    props?: StackProps;
    environmentVariables: EnvironmentVariables;
    prefixResources: string;
}

/**
 * Top-level stack for the EventBridge Global Endpoint. Deployed to the primary
 * region AFTER both regional stacks exist (the endpoint requires the event bus
 * to exist in both regions).
 */
export class GlobalEndpointStack extends Stack {
    public readonly globalEndpoint: GlobalEndpoint;

    constructor({ scope, id, props, environmentVariables, prefixResources }: GlobalEndpointStackParams) {
        super(scope, id, props);

        this.globalEndpoint = new GlobalEndpoint(
            this,
            'GlobalEndpointConstruct',
            environmentVariables,
            prefixResources,
        );
    }
}
