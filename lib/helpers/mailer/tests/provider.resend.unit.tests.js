/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// Mock resend before importing the provider
jest.unstable_mockModule('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: jest.fn(),
    },
  })),
}));

const { Resend } = await import('resend');
const { default: ResendProvider } = await import('../provider.resend.js');

describe('ResendProvider unit tests:', () => {
  let provider;
  let sendMock;

  beforeEach(() => {
    jest.clearAllMocks();
    sendMock = jest.fn();
    Resend.mockImplementation(() => ({
      emails: { send: sendMock },
    }));
    provider = new ResendProvider({ apiKey: 're_test_123' });
  });

  test('should throw if apiKey is missing', () => {
    expect(() => new ResendProvider({})).toThrow('Resend provider requires an apiKey');
    expect(() => new ResendProvider()).toThrow('Resend provider requires an apiKey');
  });

  test('should create a Resend client with the provided apiKey', () => {
    expect(Resend).toHaveBeenCalledWith('re_test_123');
  });

  test('should send an email successfully', async () => {
    const mockData = { id: 'email_123' };
    sendMock.mockResolvedValue({ data: mockData, error: null });

    const result = await provider.send({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test',
      html: '<p>Hello</p>',
    });

    expect(sendMock).toHaveBeenCalledWith({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test',
      html: '<p>Hello</p>',
    });
    expect(result).toEqual(mockData);
  });

  test('should send an email with attachments', async () => {
    const mockData = { id: 'email_456' };
    sendMock.mockResolvedValue({ data: mockData, error: null });

    const result = await provider.send({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test with attachment',
      html: '<p>See attached</p>',
      attachments: [{ filename: 'data.csv', content: 'col1,col2\nval1,val2' }],
    });

    expect(sendMock).toHaveBeenCalledWith({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test with attachment',
      html: '<p>See attached</p>',
      attachments: [
        {
          filename: 'data.csv',
          content: Buffer.from('col1,col2\nval1,val2').toString('base64'),
        },
      ],
    });
    expect(result).toEqual(mockData);
  });

  test('should throw on Resend API error', async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: 'Invalid API key' } });

    await expect(
      provider.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test',
        html: '<p>Hello</p>',
      }),
    ).rejects.toThrow('Invalid API key');
  });
});
