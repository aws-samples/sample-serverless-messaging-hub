import {Construct} from "constructs";
import {ServiceParams} from "../utils/interfaces/general-interfaces";
import {
    Policy,
    PolicyStatement,
} from "aws-cdk-lib/aws-iam";

export class Policies extends Construct {
    constructor(
        scope: Construct,
        id: string,
        props: ServiceParams
    ) {
        super(scope, id);

        const fullSNSPublish = new PolicyStatement({
            actions: ["sns:Publish"],
            resources: ["*"],
        });

        const fullSESSend = new PolicyStatement({
            actions: ["ses:SendRawEmail", "ses:SendEmail"],
            resources: ["*"],
        });

        const fullS3GetObject = new PolicyStatement({
            actions: ["s3:GetObject", "ses:SendEmail"],
            resources: ["*"],
        });

        props.messageFunctionsParams.pushEmailFunction.role?.attachInlinePolicy(
            new Policy(this, "pushEmailPolicy", {
                statements: [fullSESSend, fullS3GetObject]
            })
        );
        props.messageFunctionsParams.pushSMSFunction.role?.attachInlinePolicy(
            new Policy(this, "pushSMSPolicy", {
                statements: [fullSNSPublish, fullS3GetObject]
            })
        );
        props.dynamoDbTables.messagingTemplates.grantReadData(
            props.messageFunctionsParams.pushEmailFunction
        );
        props.dynamoDbTables.messagingTemplates.grantReadData(
            props.messageFunctionsParams.pushSMSFunction
        );
    }
}
