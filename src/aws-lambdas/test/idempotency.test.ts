import { describe, it, expect } from 'vitest';
import {
    resolveIdempotencyTtlSeconds,
    DEFAULT_IDEMPOTENCY_TTL_SECONDS,
} from '../src/libs/functions/Idempotency';

describe('resolveIdempotencyTtlSeconds', () => {
    it('defaults to 1 day when not provided', () => {
        expect(resolveIdempotencyTtlSeconds({})).toBe(DEFAULT_IDEMPOTENCY_TTL_SECONDS);
        expect(DEFAULT_IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
    });

    it('uses the template override (number)', () => {
        expect(resolveIdempotencyTtlSeconds({ idempotencyTtlSeconds: 3600 })).toBe(3600);
    });

    it('uses the template override (numeric string, as unmarshalled)', () => {
        expect(resolveIdempotencyTtlSeconds({ idempotencyTtlSeconds: '7200' })).toBe(7200);
    });

    it('falls back to default on invalid / non-positive values', () => {
        expect(resolveIdempotencyTtlSeconds({ idempotencyTtlSeconds: 'abc' })).toBe(DEFAULT_IDEMPOTENCY_TTL_SECONDS);
        expect(resolveIdempotencyTtlSeconds({ idempotencyTtlSeconds: 0 })).toBe(DEFAULT_IDEMPOTENCY_TTL_SECONDS);
        expect(resolveIdempotencyTtlSeconds({ idempotencyTtlSeconds: -5 })).toBe(DEFAULT_IDEMPOTENCY_TTL_SECONDS);
    });
});
