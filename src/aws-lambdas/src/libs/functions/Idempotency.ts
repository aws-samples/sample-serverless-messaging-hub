import { makeIdempotent, IdempotencyConfig } from '@aws-lambda-powertools/idempotency';
import { DynamoDBPersistenceLayer } from '@aws-lambda-powertools/idempotency/dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import { Context } from 'aws-lambda';

const logger = new Logger({ serviceName: 'Idempotency' });

/**
 * Default idempotency (dedup) window when a template does not specify one.
 * 1 day covers SQS retries, cross-region replication lag and short replays.
 *
 * NOTE: this window is enforced by the `#expiry < :now` branch of the conditional
 * write, NOT by DynamoDB TTL. The idempotency table runs in MRSC mode, which does
 * not support TTL, so records are never physically deleted — correctness is
 * unaffected, storage grows. See docs/idempotency-and-audit.md.
 */
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 86_400;

/**
 * Bounded in-process retry while another Region holds the claim (see `runOnce`).
 *
 * Sized against the *winner's* whole operation, not just replication latency: the
 * loser has to wait for the winner to finish sending and flip the record to
 * COMPLETED, which measured ~2 s here (SES send + audit write). Exponential backoff
 * from 300 ms over 5 attempts gives ~4.5 s of budget, well inside the 30 s Lambda
 * timeout and the 30 s SQS visibility timeout.
 */
const CONTENTION_MAX_ATTEMPTS = 5;
const CONTENTION_BACKOFF_MS = 300;

/**
 * Powertools wraps any non-"already exists" failure of the INPROGRESS claim into
 * an `IdempotencyPersistenceLayerError` carrying this exact message. The other two
 * wrap sites ("update success" / "delete") happen AFTER the guarded operation ran,
 * so they must never be retried here.
 */
const CLAIM_FAILURE_MESSAGE = 'Failed to save in progress record to idempotency store';

/** DynamoDB MRSC rejects a write that targets an item being modified in another Region. */
const MRSC_CONFLICT = 'ReplicatedWriteConflictException';

/**
 * Powertools raises this when the record exists and is still INPROGRESS — i.e. another
 * execution won the claim and has not finished yet. In an active/active topology with
 * global-endpoint replication this is the **dominant** contention path (measured: the
 * secondary Region hit it on every message, while `ReplicatedWriteConflictException`
 * never fired), so it is retried rather than surfaced as a failed invocation.
 */
const ALREADY_IN_PROGRESS = 'IdempotencyAlreadyInProgressError';

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Walks the `cause` chain looking for an error with the given name. */
function hasCauseNamed(error: unknown, name: string): boolean {
    let current: unknown = error;
    for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
        if (current.name === name) return true;
        current = (current as { cause?: unknown }).cause;
    }
    return false;
}

/**
 * True only for contention raised while claiming the key — i.e. before the side effect.
 * Two sources, both meaning "another Region is on this key, wait and re-check":
 *   1. MRSC rejected the claim write because the item is being modified elsewhere.
 *   2. The record already exists as INPROGRESS.
 * Anything else (including the same MRSC conflict raised *after* the send) is not retryable.
 */
function isClaimContention(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    if (error.name === ALREADY_IN_PROGRESS) return true;

    return error.message === CLAIM_FAILURE_MESSAGE && hasCauseNamed(error, MRSC_CONFLICT);
}

/**
 * Runs `operation` at most once per `idempotencyKey` within the given TTL window.
 *
 * Uses Powertools Idempotency (INPROGRESS → COMPLETED semantics): the record is
 * written as INPROGRESS before the side effect and COMPLETED after success; on
 * failure the record is released so SQS retries can re-attempt. A duplicate that
 * arrives within the TTL window is short-circuited (the side effect runs once).
 *
 * Multi-region: the store is a DynamoDB **MRSC** global table, so the conditional
 * claim is evaluated against the latest version of the item across Regions. This is
 * what makes the guard hold when both Regions process the same event concurrently
 * (EventBridge global endpoint replication); an eventually-consistent global table
 * lets both claims succeed inside the replication lag and sends twice.
 *
 * `context` is REQUIRED: because the guard wraps an isolated operation rather than
 * the handler, Powertools cannot discover the Lambda context on its own, and without
 * it `in_progress_expiry` is never written — a function killed without throwing
 * (timeout, OOM) would hold the key for the full TTL and its messages would reach
 * the DLQ unsent.
 */
export async function runOnce<T>(
    idempotencyKey: string,
    ttlSeconds: number,
    context: Context,
    operation: () => Promise<T>,
): Promise<T> {
    const config = new IdempotencyConfig({ expiresAfterSeconds: ttlSeconds });
    // Enables `in_progress_expiry`, so an orphaned INPROGRESS lock self-releases.
    config.registerLambdaContext(context);

    for (let attempt = 1; ; attempt += 1) {
        // `operationStarted` is the safety property: it is only ever retried while the
        // guarded side effect provably has not run. Never relax this.
        let operationStarted = false;

        const wrapped = makeIdempotent(
            async (_key: string): Promise<T> => {
                operationStarted = true;
                return operation();
            },
            { persistenceStore, config },
        );

        try {
            return await wrapped(idempotencyKey);
        } catch (error) {
            const canRetry =
                !operationStarted && attempt < CONTENTION_MAX_ATTEMPTS && isClaimContention(error);

            if (!canRetry) throw error;

            logger.info('Idempotency claim held by another execution, retrying', {
                idempotencyKey,
                attempt,
                reason: error instanceof Error ? error.name : 'unknown',
            });
            await sleep(CONTENTION_BACKOFF_MS * 2 ** (attempt - 1));
        }
    }
}
