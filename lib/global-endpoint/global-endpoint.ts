import { Construct } from 'constructs';
import { Duration, Stack } from 'aws-cdk-lib';
import { CfnEndpoint } from 'aws-cdk-lib/aws-events';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { CfnHealthCheck } from 'aws-cdk-lib/aws-route53';
import { Role, ServicePrincipal, PolicyStatement, PolicyDocument } from 'aws-cdk-lib/aws-iam';
import { EnvironmentVariables } from '../utils/interfaces/general-interfaces';

/**
 * GlobalEndpoint — EventBridge Global Endpoint for Regional fault tolerance.
 *
 * Deployed as its own stack AFTER both regional stacks, because the endpoint
 * requires a same-named event bus to exist in BOTH regions. Bus ARNs are built
 * from the deterministic bus name (no cross-stack references), so this stack has
 * no dependency on the regional stacks at synth time.
 */
export class GlobalEndpoint extends Construct {
    public readonly endpoint: CfnEndpoint;

    constructor(scope: Construct, id: string, env: EnvironmentVariables, prefix: string) {
        super(scope, id);

        const stack = Stack.of(this);
        const busName = `${prefix}-messages-bus`;
        const primaryBusArn = stack.formatArn({
            service: 'events',
            resource: 'event-bus',
            resourceName: busName,
        });
        const secondaryBusArn = stack.formatArn({
            service: 'events',
            resource: 'event-bus',
            resourceName: busName,
            region: env.secondaryRegion,
        });

        // ─── Failover trigger: latency alarm on EventBridge ingestion ───
        // Thresholds come from `failover` in the environment YAML.
        const failover = env.failover;
        const latencyAlarm = new Alarm(this, 'IngestionLatencyAlarm', {
            alarmName: `${prefix}-ingestion-to-invocation-latency`,
            alarmDescription: 'EventBridge ingestion-to-invocation latency high — triggers global endpoint failover',
            metric: new Metric({
                namespace: 'AWS/Events',
                metricName: 'IngestionToInvocationStartLatency',
                statistic: 'Maximum',
                period: Duration.minutes(failover.periodMinutes),
            }),
            threshold: failover.latencyThresholdMs,
            evaluationPeriods: failover.evaluationPeriods,
            comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: TreatMissingData.NOT_BREACHING,
        });

        // ─── Route 53 health check backed by the alarm ───
        const healthCheck = new CfnHealthCheck(this, 'EndpointHealthCheck', {
            healthCheckConfig: {
                type: 'CLOUDWATCH_METRIC',
                alarmIdentifier: {
                    name: latencyAlarm.alarmName,
                    region: stack.region,
                },
                insufficientDataHealthStatus: 'LastKnownStatus',
            },
        });
        const healthCheckArn = stack.formatArn({
            service: 'route53',
            resource: 'healthcheck',
            region: '',
            account: '',
            resourceName: healthCheck.attrHealthCheckId,
        });

        // ─── Replication role (EventBridge replicates events across regions) ───
        // Needs to manage the managed replication RULES on both buses (PutRule/
        // PutTargets) and PutEvents to both buses.
        const busRuleArns = [
            stack.formatArn({ service: 'events', resource: 'rule', resourceName: `${busName}/*` }),
            stack.formatArn({
                service: 'events',
                resource: 'rule',
                resourceName: `${busName}/*`,
                region: env.secondaryRegion,
            }),
        ];
        const replicationRole = new Role(this, 'ReplicationRole', {
            assumedBy: new ServicePrincipal('events.amazonaws.com'),
            inlinePolicies: {
                replication: new PolicyDocument({
                    statements: [
                        new PolicyStatement({
                            actions: [
                                'events:PutRule',
                                'events:PutTargets',
                                'events:DeleteRule',
                                'events:RemoveTargets',
                            ],
                            resources: busRuleArns,
                        }),
                        new PolicyStatement({
                            actions: ['events:PutEvents'],
                            resources: [primaryBusArn, secondaryBusArn],
                        }),
                        new PolicyStatement({
                            actions: ['iam:PassRole'],
                            resources: ['*'],
                            conditions: {
                                StringEquals: { 'iam:PassedToService': 'events.amazonaws.com' },
                            },
                        }),
                    ],
                }),
            },
        });

        // ─── Global Endpoint ───
        this.endpoint = new CfnEndpoint(this, 'GlobalEndpoint', {
            name: `${prefix}-endpoint`,
            eventBuses: [{ eventBusArn: primaryBusArn }, { eventBusArn: secondaryBusArn }],
            routingConfig: {
                failoverConfig: {
                    primary: { healthCheck: healthCheckArn },
                    secondary: { route: env.secondaryRegion },
                },
            },
            replicationConfig: { state: 'ENABLED' },
            roleArn: replicationRole.roleArn,
        });
        this.endpoint.node.addDependency(replicationRole);
    }
}
