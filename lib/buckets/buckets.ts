import { Construct } from 'constructs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { RemovalPolicy } from 'aws-cdk-lib';
import { EnvironmentVariables } from '../utils/interfaces/general-interfaces';

export class Buckets extends Construct {
    public readonly htmlStorage: Bucket;

    constructor(scope: Construct, id: string, environmentVariables: EnvironmentVariables, prefix: string) {
        super(scope, id);

        this.htmlStorage = new Bucket(this, 'HtmlStorage', {
            // Region in the name: S3 bucket names are global, so a per-region
            // bucket is required for multi-region deployments.
            bucketName: `${prefix}-${environmentVariables.buckets.htmlStorage}-${environmentVariables.region}`,
            publicReadAccess: false,
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            encryption: BucketEncryption.S3_MANAGED,
            removalPolicy: RemovalPolicy.DESTROY,
            // Required so `cdk destroy` can remove a versioned bucket that still
            // holds objects/versions; without this, the delete fails and leaves
            // an orphan bucket. Safe here because templates are re-uploaded on
            // deploy (they are not the source of truth).
            autoDeleteObjects: true,
            versioned: true,
        });
    }
}
