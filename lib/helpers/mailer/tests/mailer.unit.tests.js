/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// Mock config, files, and providers before importing mailer
jest.unstable_mockModule('../../../../config/index.js', () => ({
  default: {
    mailer: {
      provider: 'resend',
      from: 'test@example.com',
      options: { apiKey: 're_test_123' },
    },
  },
}));

jest.unstable_mockModule('../../files.js', () => ({
  default: {
    readFile: jest.fn().mockResolvedValue('<p>{{name}}</p>'),
  },
}));

const mockSend = jest.fn().mockResolvedValue({ id: 'email_123', accepted: ['user@example.com'], rejected: [] });
jest.unstable_mockModule('../provider.resend.js', () => ({
  default: jest.fn().mockImplementation(() => ({ send: mockSend })),
}));

jest.unstable_mockModule('../provider.nodemailer.js', () => ({
  default: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
}));

const { default: mailer } = await import('../index.js');

describe('mailer index with resend provider unit tests:', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should report as configured when from is set', () => {
    expect(mailer.isConfigured()).toBe(true);
  });

  test('should send mail using the resend provider and normalize response', async () => {
    mockSend.mockResolvedValue({ id: 'email_456' });

    const result = await mailer.sendMail({
      to: 'user@example.com',
      subject: 'Welcome',
      template: 'welcome',
      params: { name: 'Alice' },
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'test@example.com',
        to: 'user@example.com',
        subject: 'Welcome',
        html: '<p>Alice</p>',
      }),
    );
    expect(result).toEqual({ id: 'email_456', accepted: ['user@example.com'], rejected: [] });
  });

  test('should pass through response unchanged when accepted is already an array', async () => {
    mockSend.mockResolvedValue({ id: 'email_789', accepted: ['user@example.com'], rejected: [] });

    const result = await mailer.sendMail({
      to: 'user@example.com',
      subject: 'Welcome',
      template: 'welcome',
      params: { name: 'Charlie' },
    });

    expect(result).toEqual({ id: 'email_789', accepted: ['user@example.com'], rejected: [] });
  });

  test('should forward attachments to the provider', async () => {
    mockSend.mockResolvedValue({ id: 'email_attach', accepted: ['user@example.com'], rejected: [] });

    const attachments = [{ filename: 'report.csv', content: 'a,b\n1,2' }];
    await mailer.sendMail({
      to: 'user@example.com',
      subject: 'Report',
      template: 'welcome',
      params: { name: 'Carol' },
      attachments,
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments,
      }),
    );
  });

  test('should return null on send error', async () => {
    mockSend.mockRejectedValue(new Error('API failure'));

    const result = await mailer.sendMail({
      to: 'user@example.com',
      subject: 'Test',
      template: 'welcome',
      params: { name: 'Bob' },
    });

    expect(result).toBeNull();
  });
});
