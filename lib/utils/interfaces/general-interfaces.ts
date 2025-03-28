import {IHostedZone} from "aws-cdk-lib/aws-route53";
import {Certificate} from "aws-cdk-lib/aws-certificatemanager";
import {StackProps} from "aws-cdk-lib";
import {Construct} from "constructs";
import {Function} from "aws-cdk-lib/aws-lambda";
import {Bucket} from "aws-cdk-lib/aws-s3";
import {EventBus} from "aws-cdk-lib/aws-events";
import {Table} from "aws-cdk-lib/aws-dynamodb";

export interface ArchitectureRootStackParams {
    scope: Construct;
    id: string;
    props?: StackProps;
    environmentVariables: any;
    prefixResources: string;
}

export interface StaticSiteProps {
    accessLog: Bucket;
    staticSiteCertificate: Certificate;
    hostedZone: IHostedZone;
}

export interface RulesProps {
    messageEventBus: EventBus;
}

export interface DatabaseNestedParams {
    id: string;
    stackAttributes: StackAttributes;
}

export interface BucketNestedParams {
    id: string;
    stackAttributes: StackAttributes;
}

export interface BusesNestedParams {
    id: string;
    stackAttributes: StackAttributes;
}

export interface IamNestedParams {
    id: string;
    stackAttributes: StackAttributes;
    services: ServiceParams;
}

interface DynamoDbParams {
    messagingTemplates: Table;
}

interface MessageFunctionsParams {
    pushEmailFunction: Function;
    pushSMSFunction: Function;
}

export interface ServiceParams {
    messageFunctionsParams: MessageFunctionsParams;
    dynamoDbTables: DynamoDbParams;
    messageEventBus: EventBus;
}

export interface StackAttributes {
    scope: Construct;
    props?: StackProps;
    environmentVariables: any;
    prefixResources: string;
}

export interface SSMGetParameterOutput {
    Parameter?: {
        Value?: string;
        Name?: string;
        Type?: string;
        Version?: number;
        ARN?: string;
    };
}