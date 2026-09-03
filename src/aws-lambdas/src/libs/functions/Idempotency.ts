import { makeIdempotent, IdempotencyConfig } from '@aws-lambda-powertools/idempotency';
import { DynamoDBPersistenceLayer } from '@aws-lambda-powertools/idempotency/dynamodb';

/**
 * Default idempotency (dedup) window when a template does not specify one.
 * 1 day covers SQS retries, cross-region replication lag and short replays.
 */
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 86_400;

/**
 * Resolves the dedup TTL (seconds) from a template configuration item.
 * Templates may override it via the `idempotencyTtlSeconds` attribute.
 */
export function resolveIdempotencyTtlSeconds(configuration: Record<string, unknown>): number {
    const raw = configuration?.idempotencyTtlSeconds;
    const value = typeof raw === 'string' ? Number(raw) : (raw as number | undefined);
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    return DEFAULT_IDEMPOTENCY_TTL_SECONDS;
}

// Singleton persistence layer — reused across warm invocations.
const persistenceStore = new DynamoDBPersistenceLayer({
    tableName: process.env.IDEMPOTENCY_TABLE_NAME ?? '',
});

/**
 * Runs `operation` at most once per `idempotencyKey` within the given TTL window.
 *
 * Uses Powertools Idempotency (INPROGRESS → COMPLETED semantics): the record is
 * written as INPROGRESS before the side effect and COMPLETED after success; on
 * failure the record is released so SQS retries can re-attempt. A duplicate that
 * arrives within the TTL window is short-circuited (the side effect runs once).
 */
export async function runOnce<T>(
    idempotencyKey: string,
    ttlSeconds: number,
    operation: () => Promise<T>,
): Promise<T> {
    const config = new IdempotencyConfig({ expiresAfterSeconds: ttlSeconds });

    const wrapped = makeIdempotent(async (_key: string): Promise<T> => operation(), {
        persistenceStore,
        config,
    });

    return wrapped(idempotencyKey);
}
