import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CONSTANTS } from './constants';

export class Validation {
    /**
     * Validates the environment parameter passed via CDK context.
     * Throws if the environment is not one of the allowed values.
     */
    static stageValidation(env: string | undefined): void {
        if (!env) {
            throw new Error(
                `Environment parameter is required. Use: cdk deploy -c env=<${CONSTANTS.ENVIRONMENTS.join('|')}>`,
            );
        }
        if (!CONSTANTS.ENVIRONMENTS.includes(env)) {
            throw new Error(
                `Invalid environment "${env}". Allowed values: ${CONSTANTS.ENVIRONMENTS.join(', ')}`,
            );
        }
    }

    /**
     * Guards against a silent misconfiguration: every resource name is built from the
     * `-c env=` context value, so a mismatching `environment` key in the YAML would be
     * ignored rather than honoured. Fail loudly instead.
     */
    static environmentConsistency(contextEnv: string, configEnvironment: string): void {
        if (configEnvironment !== contextEnv) {
            throw new Error(
                `Config mismatch: env/env-${contextEnv}.yml declares environment "${configEnvironment}" ` +
                    `but was loaded for "-c env=${contextEnv}". Resource names derive from the context ` +
                    `value, so these must match.`,
            );
        }
    }

    /**
     * Guards the audit retention combination. An expiration that falls inside the Object
     * Lock window cannot be honoured by S3: the delete is rejected and objects survive past
     * the date the config implies, which is worse than not configuring expiry at all.
     */
    static auditRetention(cfg: {
        worm: boolean;
        wormMode: string;
        objectLockRetentionDays: number;
        glacierTransitionDays: number;
        glacierStorageClass: string;
        expirationDays: number;
    }): void {
        const tiers = ['GLACIER', 'GLACIER_IR', 'DEEP_ARCHIVE'];
        if (!tiers.includes(cfg.glacierStorageClass)) {
            throw new Error(
                `Invalid audit.glacierStorageClass "${cfg.glacierStorageClass}". ` +
                    `Allowed: ${tiers.join(', ')}.`,
            );
        }
        if (cfg.expirationDays < 0) {
            throw new Error('audit.expirationDays must be >= 0 (0 disables expiration).');
        }
        if (cfg.expirationDays > 0 && cfg.expirationDays <= cfg.glacierTransitionDays) {
            throw new Error(
                `audit.expirationDays (${cfg.expirationDays}) must be greater than ` +
                    `audit.glacierTransitionDays (${cfg.glacierTransitionDays}); otherwise objects ` +
                    `expire before they are ever archived.`,
            );
        }
        if (cfg.worm && cfg.expirationDays > 0 && cfg.expirationDays < cfg.objectLockRetentionDays) {
            throw new Error(
                `audit.expirationDays (${cfg.expirationDays}) is inside the Object Lock window ` +
                    `(audit.objectLockRetentionDays = ${cfg.objectLockRetentionDays}). S3 will refuse ` +
                    `the deletion, so objects would outlive the configured expiry. Raise ` +
                    `expirationDays to >= ${cfg.objectLockRetentionDays}, lower the lock window, or ` +
                    `set expirationDays: 0.`,
            );
        }
    }

    /**
     * CloudWatch Logs only accepts a discrete set of retention values, so an arbitrary
     * number from the YAML would be silently rejected at deploy time. Validate at synth
     * and return the matching `RetentionDays` enum member.
     */
    static logRetention(days: number): RetentionDays {
        const allowed = Object.values(RetentionDays).filter((v): v is number => typeof v === 'number');
        if (!allowed.includes(days)) {
            throw new Error(
                `Invalid observability.logRetentionDays "${days}". CloudWatch Logs accepts only: ` +
                    `${allowed.sort((a, b) => a - b).join(', ')}.`,
            );
        }
        return days as RetentionDays;
    }
}
