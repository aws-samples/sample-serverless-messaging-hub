#!/usr/bin/env node
import "source-map-support/register";
import {ArchitectureStack} from "../lib/architecture-stack";
import * as cdk from "aws-cdk-lib";
import {Tags} from "aws-cdk-lib";
import {Validation} from "../lib/utils/validation";
import {CONSTANTS} from "../lib/utils/constants";
import * as yml from "yamljs";
import {getParameterValue} from "../lib/utils/commons";

const app = new cdk.App();
const env = app.node.tryGetContext("env");
Validation.stageValidation(env);

const environmentVariables = yml.load(`env-${env}.yml`);
const prefixResources = `${CONSTANTS.APP_ORGANIZATION}-${env}-${CONSTANTS.APP_NAME}`;

getParameterValue(environmentVariables.account)
    .then(secretValue => {
        const environment = {
            env: {
                description: 'Serverless Architecture Stack',
                account: String(secretValue),
                region: environmentVariables.region,
                terminationProtection: true
            }
        };

        const architectureStack = new ArchitectureStack({
                scope: app,
                id: `${env}-architecture-${CONSTANTS.APP_NAME}`,
                props: environment,
                environmentVariables: environmentVariables,
                prefixResources
            }
        );
        Tags.of(architectureStack).add(CONSTANTS.TAG_POLICIES.KEY_NAMES.PRODUCT,
            CONSTANTS.TAG_POLICIES.KEY_VALUES.PRODUCT.INFRASTRUCTURE);
        Tags.of(architectureStack).add(CONSTANTS.TAG_POLICIES.KEY_NAMES.OWNER,
            CONSTANTS.TAG_POLICIES.KEY_VALUES.OWNER.CLOUD_TEAM);
        Tags.of(architectureStack).add(CONSTANTS.TAG_POLICIES.KEY_NAMES.ENVIRONMENT,
            env);
    })
    .catch(error => {
        console.error('Failed to get parameter:', error);
    });

