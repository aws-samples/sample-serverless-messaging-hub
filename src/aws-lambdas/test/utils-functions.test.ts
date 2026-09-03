import { describe, it, expect, afterEach } from 'vitest';
import { generateTemplate, generateSMSMessage, generateEmailMessage } from '../src/libs/functions/UtilsFunctions';

describe('generateTemplate (Handlebars)', () => {
    it('interpolates variables', () => {
        expect(generateTemplate({ name: 'Jane' }, 'Hi {{name}}!')).toBe('Hi Jane!');
    });

    it('renders empty string for missing variables', () => {
        expect(generateTemplate({}, 'Hi {{name}}!')).toBe('Hi !');
    });
});

describe('generateEmailMessage', () => {
    const detail = {
        idempotencyKey: 'k',
        product: 'demo',
        channel: 'email',
        feature: 'welcome',
        language: 'en',
        mail: 'a@example.com',
        name: 'Jane',
    } as never;

    it('renders the HTML body and builds the SES input from config', () => {
        const emailConfig = {
            configuration: { subject: 'Welcome', source: 'Demo <no-reply@example.com>' },
            template: '<p>Hi {{name}}</p>',
        };
        const input = generateEmailMessage(detail, emailConfig as never);
        expect(input.Destination.ToAddresses).toEqual(['a@example.com']);
        expect(input.Message.Body.Html.Data).toBe('<p>Hi Jane</p>');
        expect(input.Source).toBe('Demo <no-reply@example.com>');
    });

    it('adds ConfigurationSetName + idempotencyKey tag when SES_CONFIGURATION_SET is set', () => {
        process.env.SES_CONFIGURATION_SET = 'acme-dev-messaging-hub-config-set';
        const emailConfig = {
            configuration: { subject: 'Welcome', source: 'Demo <no-reply@example.com>' },
            template: '<p>Hi</p>',
        };
        const input = generateEmailMessage(detail, emailConfig as never) as Record<string, unknown>;
        expect(input.ConfigurationSetName).toBe('acme-dev-messaging-hub-config-set');
        expect(input.Tags).toEqual([{ Name: 'idempotencyKey', Value: 'k' }]);
        delete process.env.SES_CONFIGURATION_SET;
    });

    it('omits ConfigurationSetName when SES_CONFIGURATION_SET is not set', () => {
        const emailConfig = {
            configuration: { subject: 'Welcome', source: 'Demo <no-reply@example.com>' },
            template: '<p>Hi</p>',
        };
        const input = generateEmailMessage(detail, emailConfig as never) as Record<string, unknown>;
        expect(input.ConfigurationSetName).toBeUndefined();
        expect(input.Tags).toBeUndefined();
    });
});

describe('generateSMSMessage', () => {
    const detail = {
        idempotencyKey: 'k',
        product: 'demo',
        channel: 'sms',
        feature: 'welcome',
        language: 'en',
        phoneNumber: '+15555550100',
        name: 'Jane',
    } as never;

    const configuration = { template: '{{name}}, welcome!' } as Record<string, string>;

    afterEach(() => {
        delete process.env.SMS_SENDER_ID;
    });

    it('renders the message body and targets the phone number', () => {
        const out = generateSMSMessage(detail, configuration);
        expect(out.PhoneNumber).toBe('+15555550100');
        expect(out.Message).toBe('Jane, welcome!');
    });

    it('always marks the SMS as Transactional', () => {
        const out = generateSMSMessage(detail, configuration);
        expect(out.MessageAttributes['AWS.SNS.SMS.SMSType'].StringValue).toBe('Transactional');
    });

    it('omits SenderID when SMS_SENDER_ID is not configured', () => {
        const out = generateSMSMessage(detail, configuration);
        expect(out.MessageAttributes['AWS.SNS.SMS.SenderID']).toBeUndefined();
    });

    it('includes SenderID when SMS_SENDER_ID is configured', () => {
        process.env.SMS_SENDER_ID = 'ACME';
        const out = generateSMSMessage(detail, configuration);
        expect(out.MessageAttributes['AWS.SNS.SMS.SenderID'].StringValue).toBe('ACME');
    });
});
