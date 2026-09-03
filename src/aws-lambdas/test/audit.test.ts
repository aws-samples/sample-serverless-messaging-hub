import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@aws-sdk/client-firehose', () => ({
    FirehoseClient: vi.fn(() => ({ send: sendMock })),
    PutRecordCommand: vi.fn((input: unknown) => ({ input })),
}));

import { recordAcceptance } from '../src/libs/functions/Audit';

describe('recordAcceptance', () => {
    const base = {
        idempotencyKey: 'k-1',
        product: 'demo',
        channel: 'email',
        feature: 'welcome',
        language: 'en',
        recipient: 'user@example.com',
        providerMessageId: 'ses-123',
        status: 'ACCEPTED' as const,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        sendMock.mockResolvedValue({});
        process.env.AUDIT_FIREHOSE_STREAM = 'acme-dev-messaging-hub-audit';
    });

    afterEach(() => {
        delete process.env.AUDIT_FIREHOSE_STREAM;
    });

    it('hashes the recipient (no PII in the record) and sends to Firehose', async () => {
        await recordAcceptance(base);

        expect(sendMock).toHaveBeenCalledTimes(1);
        const data = sendMock.mock.calls[0][0].input.Record.Data.toString();
        const parsed = JSON.parse(data);

        const expectedHash = createHash('sha256').update('user@example.com').digest('hex');
        expect(parsed.recipientHash).toBe(expectedHash);
        expect(data).not.toContain('user@example.com');
        expect(parsed.status).toBe('ACCEPTED');
        expect(parsed.providerMessageId).toBe('ses-123');
        expect(parsed.idempotencyKey).toBe('k-1');
    });

    it('skips when the stream env var is not set', async () => {
        delete process.env.AUDIT_FIREHOSE_STREAM;
        await recordAcceptance(base);
        expect(sendMock).not.toHaveBeenCalled();
    });

    it('never throws if Firehose fails (best-effort)', async () => {
        sendMock.mockRejectedValue(new Error('firehose down'));
        await expect(recordAcceptance(base)).resolves.toBeUndefined();
    });
});
