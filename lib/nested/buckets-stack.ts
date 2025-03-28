import {NestedStack} from "aws-cdk-lib";
import {BucketNestedParams} from "../utils/interfaces/general-interfaces";
import {Buckets} from "../buckets/buckets";

export class BucketsStack extends NestedStack {
    public readonly buckets: Buckets;
    constructor({id, stackAttributes}: BucketNestedParams) {
        super(stackAttributes.scope, id, stackAttributes.props);

        this.buckets = new Buckets(this, 'BucketStackConstruct',
            stackAttributes.environmentVariables,
            stackAttributes.prefixResources);
    }
}
