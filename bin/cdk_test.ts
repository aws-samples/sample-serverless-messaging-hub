#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib';
import {ArchitectureStack} from "../lib/architecture-stack";
import {Validation} from "../lib/utils/validation";
import * as yml from "yamljs";
import {CONSTANTS} from "../lib/utils/constants";

const app = new cdk.App();
const env = app.node.tryGetContext("env");
Validation.stageValidation(env);

const environmentVariables = yml.load(`env-${env}.yml`);
const prefixResources = `${CONSTANTS.APP_ORGANIZATION}-${env}-${CONSTANTS.APP_NAME}`;
const environment = {
    env: {
        description: 'Serverless Architecture Stack',
        account: environmentVariables.account,
        region: environmentVariables.region,
        terminationProtection: true
    }
};

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))
new ArchitectureStack({
    scope: app,
    id: `${env}-architecture-${CONSTANTS.APP_NAME}`,
    props: environment,
    environmentVariables: environmentVariables,
    prefixResources
});