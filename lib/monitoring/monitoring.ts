import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import {
    Alarm,
    ComparisonOperator,
    IMetric,
    TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { IQueue } from 'aws-cdk-lib/aws-sqs';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import { AlarmsConfig, MonitoringServiceParams } from '../utils/interfaces/general-interfaces';

/**
 * Monitoring — CloudWatch alarms wired to an SNS topic (email subscription).
 *
 * Alarms created per channel (email + sms), 8 per region:
 *   1. DLQ has any visible message  → a message failed all retries (highest signal)
 *   2. Lambda Errors                → processing failures
 *   3. Lambda Throttles             → concurrency starvation
 *   4. Oldest message age           → a stuck / backed-up consumer
 *
 * All thresholds, periods and evaluation periods come from `monitoring.alarms` in the
 * environment YAML so each stage can be tuned without code edits. The comparison
 * operator and missing-data treatment are deliberately fixed: every alarm here is a
 * "breach upward" signal and absent data means healthy, not unknown.
 *
 * Every alarm notifies (ALARM) and clears (OK) through the same SNS topic so the
 * on-call recipient sees both the incident and its resolution.
 */
export class Monitoring extends Construct {
    public readonly alarmTopic: Topic;

    private readonly action: SnsAction;
    private readonly prefix: string;
    private readonly alarms: AlarmsConfig;

    constructor(
        scope: Construct,
        id: string,
        props: MonitoringServiceParams,
        alarmEmail: string,
        prefix: string,
        alarms: AlarmsConfig,
    ) {
        super(scope, id);

        this.prefix = prefix;
        this.alarms = alarms;

        this.alarmTopic = new Topic(this, 'AlarmTopic', {
            topicName: `${prefix}-alarms`,
            displayName: `${prefix} alarms`,
        });
        this.alarmTopic.addSubscription(new EmailSubscription(alarmEmail));

        this.action = new SnsAction(this.alarmTopic);

        // ─── Dead Letter Queues: any message here means a poison/failed message ───
        this.dlqDepthAlarm('EmailDlqNotEmpty', props.dlqs.emailDlq, 'email');
        this.dlqDepthAlarm('SmsDlqNotEmpty', props.dlqs.smsDlq, 'sms');

        // ─── Lambda health (errors + throttles) ───
        this.lambdaErrorsAlarm('EmailLambdaErrors', props.functions.emailFunction, 'email');
        this.lambdaErrorsAlarm('SmsLambdaErrors', props.functions.smsFunction, 'sms');
        this.lambdaThrottlesAlarm('EmailLambdaThrottles', props.functions.emailFunction, 'email');
        this.lambdaThrottlesAlarm('SmsLambdaThrottles', props.functions.smsFunction, 'sms');

        // ─── Backlog age: detect a stuck / lagging consumer ───
        this.queueAgeAlarm('EmailQueueAge', props.queues.emailQueue, 'email');
        this.queueAgeAlarm('SmsQueueAge', props.queues.smsQueue, 'sms');
    }

    private buildAlarm(id: string, alarmName: string, metric: IMetric, threshold: number, description: string): Alarm {
        const alarm = new Alarm(this, id, {
            alarmName: `${this.prefix}-${alarmName}`,
            alarmDescription: description,
            metric,
            threshold,
            evaluationPeriods: this.alarms.evaluationPeriods,
            comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: TreatMissingData.NOT_BREACHING,
        });
        alarm.addAlarmAction(this.action);
        alarm.addOkAction(this.action);
        return alarm;
    }

    private dlqDepthAlarm(id: string, dlq: IQueue, channel: string): Alarm {
        const cfg = this.alarms.dlqDepth;
        const metric = dlq.metricApproximateNumberOfMessagesVisible({
            period: Duration.minutes(cfg.periodMinutes),
            statistic: 'Maximum',
        });
        return this.buildAlarm(
            id,
            `${channel}-dlq-not-empty`,
            metric,
            cfg.threshold,
            `A ${channel} message exhausted all retries and landed in the DLQ`,
        );
    }

    private lambdaErrorsAlarm(id: string, fn: IFunction, channel: string): Alarm {
        const cfg = this.alarms.lambdaErrors;
        const metric = fn.metricErrors({ period: Duration.minutes(cfg.periodMinutes), statistic: 'Sum' });
        return this.buildAlarm(
            id,
            `${channel}-lambda-errors`,
            metric,
            cfg.threshold,
            `The ${channel} Lambda reported errors`,
        );
    }

    private lambdaThrottlesAlarm(id: string, fn: IFunction, channel: string): Alarm {
        const cfg = this.alarms.lambdaThrottles;
        const metric = fn.metricThrottles({ period: Duration.minutes(cfg.periodMinutes), statistic: 'Sum' });
        return this.buildAlarm(
            id,
            `${channel}-lambda-throttles`,
            metric,
            cfg.threshold,
            `The ${channel} Lambda is being throttled (concurrency limit)`,
        );
    }

    private queueAgeAlarm(id: string, queue: IQueue, channel: string): Alarm {
        const cfg = this.alarms.queueAge;
        const metric = queue.metricApproximateAgeOfOldestMessage({
            period: Duration.minutes(cfg.periodMinutes),
            statistic: 'Maximum',
        });
        return this.buildAlarm(
            id,
            `${channel}-queue-age`,
            metric,
            cfg.threshold, // seconds
            `The oldest ${channel} message has been waiting > ${cfg.threshold / 60} min` +
                ` (possible stuck consumer)`,
        );
    }
}
