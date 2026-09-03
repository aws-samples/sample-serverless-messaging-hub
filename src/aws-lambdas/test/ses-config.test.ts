import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the AWS-backed operations so we can test the config resolution logic
// (templatePath usage) in isolation, with no network calls.
vi.mock('../src/libs/functions/DynamoDbOperations', () => ({
    getConfigurationItem: vi.fn(),
}));
vi.mock('../src/libs/functions/S3Operations', () => ({
    getTemplate: vi.fn(),
}));

import { createSESTemplate, EmailConfigService } from '../src/utils/SESConfig';
import { getConfigurationItem } from '../src/libs/functions/DynamoDbOperations';
import { getTemplate } from '../src/libs/functions/S3Operations';

const mockedGetConfig = vi.mocked(getConfigurationItem);
const mockedGetTemplate = vi.mocked(getTemplate);

describe('createSESTemplate', () => {
    it('wraps a single recipient into ToAddresses array', () => {
        const out = createSESTemplate({
            toAddresses: 'a@example.com',
            subject: 'Hi',
            htmlMessage: '<p>x</p>',
            source: 'Demo <no-reply@example.com>',
        });
        expect(out.Destination.ToAddresses).toEqual(['a@example.com']);
        expect(out.Source).toBe('Demo <no-reply@example.com>');
        expect(out.Message.Body.Html.Data).toBe('<p>x</p>');
    });

    it('keeps an array of recipients as-is', () => {
        const out = createSESTemplate({
            toAddresses: ['a@example.com', 'b@example.com'],
            htmlMessage: '<p>x</p>',
            source: 's@example.com',
        });
        expect(out.Destination.ToAddresses).toEqual(['a@example.com', 'b@example.com']);
    });

    it('falls back to configurationSubject when subject is absent', () => {
        const out = createSESTemplate({
            toAddresses: 'a@example.com',
            configurationSubject: 'Config Subject',
            htmlMessage: '<p>x</p>',
            source: 's@example.com',
        });
        expect(out.Message.Subject.Data).toBe('Config Subject');
    });

    it('throws when source is missing', () => {
        expect(() =>
            createSESTemplate({
                toAddresses: 'a@example.com',
                htmlMessage: '<p>x</p>',
                source: '',
            }),
        ).toThrow('source is required');
    });
});

describe('EmailConfigService.getEmailConfig', () => {
    const filter = { product: 'demo', channel: 'email', feature: 'welcome', language: 'en' };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reads the S3 key from the DynamoDB templatePath attribute', async () => {
        mockedGetConfig.mockResolvedValue({
            subject: 'Welcome',
            source: 'Demo <no-reply@example.com>',
            templatePath: 'demo/en/welcome.html',
        } as never);
        mockedGetTemplate.mockResolvedValue('<h1>Welcome</h1>');

        const config = await EmailConfigService.getEmailConfig(filter);

        expect(mockedGetTemplate).toHaveBeenCalledWith('demo/en/welcome.html');
        expect(config.template).toBe('<h1>Welcome</h1>');
        expect(config.configuration.subject).toBe('Welcome');
    });

    it('throws (and does not read S3) when templatePath is missing', async () => {
        mockedGetConfig.mockResolvedValue({ subject: 'Welcome' } as never);

        await expect(EmailConfigService.getEmailConfig(filter)).rejects.toThrow(/templatePath/);
        expect(mockedGetTemplate).not.toHaveBeenCalled();
    });
});
