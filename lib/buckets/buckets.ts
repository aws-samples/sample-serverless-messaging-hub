import {Construct} from "constructs";
import {
    BlockPublicAccess,
    Bucket,
} from "aws-cdk-lib/aws-s3";
import {RemovalPolicy} from "aws-cdk-lib";

export class Buckets extends Construct {

    public readonly htmlStorage: Bucket;

    constructor(
        scope: Construct,
        id: string,
        environmentVariables: any,
        prefix: string
    ) {
        super(scope, id);

        this.htmlStorage = new Bucket(this, 'HtmlStorage', {
            bucketName: `${prefix}-${environmentVariables.buckets.htmlStorage}`,
            publicReadAccess: false,
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            removalPolicy: RemovalPolicy.DESTROY,
            versioned: true,
        });
    }
}
