import { NestedStack } from 'aws-cdk-lib';
import { BucketsNestedParams } from '../utils/interfaces/general-interfaces';
import { Buckets } from '../buckets/buckets';

export class BucketsStack extends NestedStack {
    public readonly storage: Buckets;

    constructor({ id, stackAttributes }: BucketsNestedParams) {
        super(stackAttributes.scope, id, stackAttributes.props);

        this.storage = new Buckets(
            this,
            'BucketsConstruct',
            stackAttributes.environmentVariables,
            stackAttributes.prefixResources,
        );
    }
}
