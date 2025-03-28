import {Construct} from 'constructs';
import {Rule} from "aws-cdk-lib/aws-events";
import {RulesProps} from "../utils/interfaces/general-interfaces";
import {Queue} from "aws-cdk-lib/aws-sqs";
import {SqsQueue} from "aws-cdk-lib/aws-events-targets";
import {Duration} from "aws-cdk-lib";
import {SqsEventSource} from "aws-cdk-lib/aws-lambda-event-sources";
import {createLambdaFunction} from "../utils/lambda-commons";
import {Function} from "aws-cdk-lib/aws-lambda";

export class MessageRules extends Construct {
    public readonly emailRule: Rule;
    public readonly smsRule: Rule;
    public readonly pushEmailQueue: Queue;
    public readonly pushSMSQueue: Queue;
    public readonly pushEmailFunction: Function;
    public readonly pushSMSFunction: Function;

    constructor(scope: Construct, id: string, props: RulesProps, environmentVariables: any, prefix: string) {
        super(scope, id);
        const messageProcess = environmentVariables.eventBus.rules["messages"];
        const crossSourcePath = environmentVariables.code.lambda.source['cross'];

        this.pushEmailFunction = createLambdaFunction(this,
            `${prefix}-${crossSourcePath["email"].id}`,
            `${prefix}-${crossSourcePath["email"].functionName}`,
            crossSourcePath["email"].description,
            crossSourcePath["email"].entry,
            crossSourcePath["email"].timeout,
            crossSourcePath["email"].memory);

        this.pushSMSFunction = createLambdaFunction(this,
            `${prefix}-${crossSourcePath["sms"].id}`,
            `${prefix}-${crossSourcePath["sms"].functionName}`,
            crossSourcePath["sms"].description,
            crossSourcePath["sms"].entry,
            crossSourcePath["sms"].timeout,
            crossSourcePath["sms"].memory);

        this.pushEmailQueue = new Queue(this, "PushEmailQueue", {
            queueName: `${prefix}-${environmentVariables.sqs["mailing"].email.name}`,
            visibilityTimeout: Duration.seconds(environmentVariables.sqs["mailing"].email.visibilityTimeout)
        });

        this.pushSMSQueue = new Queue(this, "PushSMSQueue", {
            queueName: `${prefix}-${environmentVariables.sqs["mailing"].sms.name}`,
            visibilityTimeout: Duration.seconds(environmentVariables.sqs["mailing"].sms.visibilityTimeout)
        });

        const pushEmailEventSource = new SqsEventSource(this.pushEmailQueue, {
            batchSize: 1
        });
        this.pushEmailFunction.addEventSource(pushEmailEventSource);

        const pushSMSEventSource = new SqsEventSource(this.pushSMSQueue, {
            batchSize: 1
        });
        this.pushSMSFunction.addEventSource(pushSMSEventSource);

        this.emailRule = new Rule(this, 'PushEmailMessage', {
            ruleName: `${prefix}-email-component`,
            description: 'Rule related to push messages (email) with SES',
            eventBus: props.messageEventBus,
            eventPattern: {
                source: [messageProcess.source],
                detailType: [messageProcess.detailType.email]
            },
            targets: [
                new SqsQueue(this.pushEmailQueue)
            ]
        });

        this.smsRule = new Rule(this, 'OnboardingTermsCond', {
            ruleName: `${prefix}-sms-component`,
            description: 'Rule related to push messages (SMS) with SNS',
            eventBus: props.messageEventBus,
            eventPattern: {
                source: [messageProcess.source],
                detailType: [messageProcess.detailType.sms]
            },
            targets: [
                new SqsQueue(this.pushSMSQueue)
            ]
        });


        this.pushEmailFunction.addEnvironment('MESSAGING_TABLE_NAME',
            `${prefix}-${environmentVariables.databases.dynamo.messaging}`);
        this.pushEmailFunction.addEnvironment('MESSAGING_TEMPLATES_BUCKET',
            `${prefix}-${environmentVariables.buckets.htmlStorage}`);
        this.pushEmailFunction.addEnvironment('URL_SQS_RECEIPT_EMAIL',
            `https://sqs.${environmentVariables.region}.amazonaws.com/${environmentVariables.account}/${prefix}-${environmentVariables.sqs.mailing.email.name}`);

        this.pushSMSFunction.addEnvironment('MESSAGING_TABLE_NAME',
            `${prefix}-${environmentVariables.databases.dynamo.messaging}`);
        this.pushSMSFunction.addEnvironment('MESSAGING_TEMPLATES_BUCKET',
            `${prefix}-${environmentVariables.buckets.htmlStorage}`);
        this.pushSMSFunction.addEnvironment('URL_SQS_RECEIPT_SMS',
            `https://sqs.${environmentVariables.region}.amazonaws.com/${environmentVariables.account}/${prefix}-${environmentVariables.sqs.mailing.sms.name}`);
    }
}
