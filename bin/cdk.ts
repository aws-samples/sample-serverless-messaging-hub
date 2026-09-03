#!/usr/bin/env node
import 'source-map-support/register';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as yml from 'yamljs';
import { ArchitectureStack } from '../lib/architecture-stack';
import { Validation } from '../lib/utils/validation';
import { CONSTANTS } from '../lib/utils/constants';
import { getParameterValue } from '../lib/utils/commons';
import { EnvironmentVariables, StackRole } from '../lib/utils/interfaces/general-interfaces';
import { GlobalEndpointStack } from '../lib/global-endpoint-stack';

/**
 * CDK entry point.
 *
 * Account resolution: the target AWS account ID is stored in SSM and must be a
 * concrete value at synth time (CDK `env.account` cannot be a token), so it is
 * read via the SSM SDK inside an async bootstrap before defining the stacks.
 *
 * Multi-region: the stack is deployed once per region. The PRIMARY region owns
 * the stateful/global resources (DynamoDB Global Table definition + the
 * EventBridge Global Endpoint); the SECONDARY region (when `secondaryRegion` is
 * set) deploys the consumer plane (bus, rules, queues, Lambdas, audit) and
 * imports the Global Table replicas by name. With no `secondaryRegion` set, only
 * the primary region is deployed (single-region behaviour).
 */
async function main(): Promise<void> {
    const app = new cdk.App();
    const env = app.node.tryGetContext('env');

    Validation.stageValidation(env);

    // Resolved against the repo root, not the CWD, so `cdk` works from any directory.
    const configPath = path.resolve(__dirname, '..', 'env', `env-${env}.yml`);
    const environmentVariables = yml.load(configPath) as EnvironmentVariables;

    Validation.environmentConsistency(env, environmentVariables.environment);

    const { appName } = environmentVariables;

    // SSM path defaults to `/${appName}/${environment}/account` so rebranding only
    // requires editing `organization` + `appName`. Override with `account` in the YAML
    // if your org uses a different Parameter Store convention.
    const accountSsmPath = environmentVariables.account ?? `/${appName}/${env}/account`;
    const account = await getParameterValue(accountSsmPath);

    const prefixResources = `${environmentVariables.organization}-${env}-${appName}`;

    const primaryRegion = environmentVariables.primaryRegion;
    const secondaryRegion = environmentVariables.secondaryRegion;
    const regions =
        secondaryRegion && secondaryRegion !== primaryRegion
            ? [primaryRegion, secondaryRegion]
            : [primaryRegion];

    for (const region of regions) {
        const stackRole: StackRole = region === primaryRegion ? 'primary' : 'secondary';

        // Keep the primary stack name stable; suffix only the secondary.
        const id =
            stackRole === 'primary'
                ? `${env}-architecture-${appName}`
                : `${env}-architecture-${appName}-${region}`;

        const regionEnvironmentVariables: EnvironmentVariables = { ...environmentVariables, region };

        const architectureStack = new ArchitectureStack({
            scope: app,
            id,
            props: {
                env: { account: String(account), region },
            },
            environmentVariables: regionEnvironmentVariables,
            prefixResources,
            stackRole,
        });

        cdk.Tags.of(architectureStack).add(
            CONSTANTS.TAG_POLICIES.KEY_NAMES.PRODUCT,
            environmentVariables.tags.product,
        );
        cdk.Tags.of(architectureStack).add(
            CONSTANTS.TAG_POLICIES.KEY_NAMES.OWNER,
            environmentVariables.tags.owner,
        );
        cdk.Tags.of(architectureStack).add(CONSTANTS.TAG_POLICIES.KEY_NAMES.ENVIRONMENT, env);
    }

    // ─── Global Endpoint — deployed LAST (needs the bus in both regions) ───
    if (secondaryRegion && secondaryRegion !== primaryRegion) {
        const endpointStack = new GlobalEndpointStack({
            scope: app,
            id: `${env}-global-endpoint-${appName}`,
            props: { env: { account: String(account), region: primaryRegion } },
            environmentVariables: { ...environmentVariables, region: primaryRegion },
            prefixResources,
        });
        cdk.Tags.of(endpointStack).add(CONSTANTS.TAG_POLICIES.KEY_NAMES.ENVIRONMENT, env);
    }

    app.synth();
}

main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
});
