import { describe, it, expect } from 'vitest';
import { createRequestPayload } from '../src/libs/validators/RequestValidator';
import { CHANNEL_TYPES } from '../src/common/UtilsConstants';

const emailSchema = createRequestPayload(CHANNEL_TYPES.EMAIL);
const smsSchema = createRequestPayload(CHANNEL_TYPES.SMS);

describe('RequestValidator — email', () => {
    const base = {
        idempotencyKey: 'k-1',
        product: 'demo',
        channel: 'email',
        feature: 'welcome',
        language: 'en',
    };

    it('accepts a single email string', () => {
        const result = emailSchema.safeParse({ detail: { ...base, mail: 'a@example.com' } });
        expect(result.success).toBe(true);
    });

    it('accepts a non-empty array of emails', () => {
        const result = emailSchema.safeParse({
            detail: { ...base, mail: ['a@example.com', 'b@example.com'] },
        });
        expect(result.success).toBe(true);
    });

    it('rejects an empty array of emails', () => {
        const result = emailSchema.safeParse({ detail: { ...base, mail: [] } });
        expect(result.success).toBe(false);
    });

    it('rejects an invalid email', () => {
        const result = emailSchema.safeParse({ detail: { ...base, mail: 'not-an-email' } });
        expect(result.success).toBe(false);
    });

    it('rejects a missing idempotencyKey', () => {
        const { idempotencyKey, ...noKey } = base;
        const result = emailSchema.safeParse({ detail: { ...noKey, mail: 'a@example.com' } });
        expect(result.success).toBe(false);
    });

    it('rejects an idempotencyKey with SES-tag-unsafe characters', () => {
        const result = emailSchema.safeParse({
            detail: { ...base, idempotencyKey: 'bad key!', mail: 'a@example.com' },
        });
        expect(result.success).toBe(false);
    });

    it('rejects a missing required field', () => {
        const result = emailSchema.safeParse({
            detail: { idempotencyKey: 'k', channel: 'email', feature: 'welcome', language: 'en', mail: 'a@example.com' },
        });
        expect(result.success).toBe(false);
    });

    it('passes through extra template variables (name, lastName)', () => {
        const result = emailSchema.safeParse({
            detail: { ...base, mail: 'a@example.com', name: 'Jane', lastName: 'Doe' },
        });
        expect(result.success).toBe(true);
    });
});

describe('RequestValidator — sms', () => {
    const base = {
        idempotencyKey: 'k-2',
        product: 'demo',
        channel: 'sms',
        feature: 'welcome',
        language: 'en',
    };

    it('accepts a valid phoneNumber', () => {
        const result = smsSchema.safeParse({ detail: { ...base, phoneNumber: '+15555550100' } });
        expect(result.success).toBe(true);
    });

    it('rejects a missing phoneNumber', () => {
        const result = smsSchema.safeParse({ detail: base });
        expect(result.success).toBe(false);
    });

    it('rejects a missing idempotencyKey', () => {
        const { idempotencyKey, ...noKey } = base;
        const result = smsSchema.safeParse({ detail: { ...noKey, phoneNumber: '+15555550100' } });
        expect(result.success).toBe(false);
    });
});
