import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'aws-lambda';

/**
 * Guards the safety invariant of `runOnce`'s MRSC claim retry: it may only retry while the
 * guarded side effect provably has NOT run. Getting this wrong re-introduces the duplicate
 * send that MRSC exists to prevent, so these cases matter more than their size suggests.
 */

const { behaviours, registeredContexts } = vi.hoisted(() => ({
    // Each entry decides what the fake Powertools wrapper does on that attempt.
    behaviours: [] as Array<
        'run' | 'claim-conflict' | 'already-in-progress' | 'post-send-conflict' | 'other-error'
    >,
    registeredContexts: [] as unknown[],
}));

vi.mock('@aws-lambda-powertools/idempotency', () => ({
    IdempotencyConfig: vi.fn(() => ({
        registerLambdaContext: (ctx: unknown) => registeredContexts.push(ctx),
    })),
    // Mirrors Powertools: the wrapper either invokes the guarded fn or throws before it.
    makeIdempotent: (fn: (key: string) => Promise<unknown>) => async (key: string) => {
        const behaviour = behaviours.shift() ?? 'run';

        if (behaviour === 'claim-conflict') throw claimConflict();
        if (behaviour === 'already-in-progress') throw alreadyInProgress();
        if (behaviour === 'other-error') throw new Error('something else entirely');

        const result = await fn(key); // side effect runs here
        if (behaviour === 'post-send-conflict') throw postSendConflict();
        return result;
    },
}));

vi.mock('@aws-lambda-powertools/idempotency/dynamodb', () => ({
    DynamoDBPersistenceLayer: vi.fn(() => ({})),
}));

function withCause(message: string, causeName: string): Error {
    const cause = new Error('mrsc conflict');
    cause.name = causeName;
    const error = new Error(message);
    (error as { cause?: unknown }).cause = cause;
    return error;
}

/** What Powertools throws when the INPROGRESS claim hits an MRSC conflict (before the send). */
const claimConflict = () =>
    withCause('Failed to save in progress record to idempotency store', 'ReplicatedWriteConflictException');

/** Same underlying conflict, but raised AFTER the send — must never be retried. */
const postSendConflict = () =>
    withCause('Failed to update success record to idempotency store', 'ReplicatedWriteConflictException');

/**
 * The dominant contention path in active/active: the record exists as INPROGRESS because
 * another Region won the claim and has not finished. Measured on every message.
 */
function alreadyInProgress(): Error {
    const error = new Error('There is already an execution in progress');
    error.name = 'IdempotencyAlreadyInProgressError';
    return error;
}

import { runOnce } from '../src/libs/functions/Idempotency';

const fakeContext = { getRemainingTimeInMillis: () => 30_000 } as unknown as Context;

/** Kept in sync with the constant in Idempotency.ts. */
const CONTENTION_MAX_ATTEMPTS = 5;

describe('runOnce — idempotency claim contention', () => {
    beforeEach(() => {
        behaviours.length = 0;
        registeredContexts.length = 0;
    });

    it('registers the Lambda context (enables in_progress_expiry)', async () => {
        await runOnce('key-1', 60, fakeContext, async () => 'ok');
        expect(registeredContexts).toContain(fakeContext);
    });

    it('retries a claim conflict and runs the side effect exactly once', async () => {
        behaviours.push('claim-conflict', 'claim-conflict', 'run');
        const operation = vi.fn(async () => 'sent');

        await expect(runOnce('key-2', 60, fakeContext, operation)).resolves.toBe('sent');
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry once the side effect has run, even for the same conflict', async () => {
        behaviours.push('post-send-conflict');
        const operation = vi.fn(async () => 'sent');

        await expect(runOnce('key-3', 60, fakeContext, operation)).rejects.toThrow(
            'Failed to update success record',
        );
        // The critical assertion: retrying here would send twice.
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('retries IdempotencyAlreadyInProgressError — the dominant contention path', async () => {
        behaviours.push('already-in-progress', 'already-in-progress', 'run');
        const operation = vi.fn(async () => 'sent');

        await expect(runOnce('key-6', 60, fakeContext, operation)).resolves.toBe('sent');
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('does not retry errors that are not claim contention', async () => {
        behaviours.push('other-error');
        const operation = vi.fn(async () => 'sent');

        await expect(runOnce('key-4', 60, fakeContext, operation)).rejects.toThrow(
            'something else entirely',
        );
        expect(operation).not.toHaveBeenCalled();
    });

    it('gives up after the attempt budget and surfaces the conflict', async () => {
        // One conflict per attempt in the budget, so the last one propagates.
        behaviours.push(...Array(CONTENTION_MAX_ATTEMPTS).fill('claim-conflict'));
        const operation = vi.fn(async () => 'sent');

        await expect(runOnce('key-5', 60, fakeContext, operation)).rejects.toThrow(
            'Failed to save in progress record',
        );
        expect(operation).not.toHaveBeenCalled();
    });
});
