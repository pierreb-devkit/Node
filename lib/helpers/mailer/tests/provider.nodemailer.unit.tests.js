/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// Mock nodemailer before importing the provider
jest.unstable_mockModule('nodemailer', () => ({
  default: {
    createTransport: jest.fn(),
  },
}));

const nodemailer = (await import('nodemailer')).default;
const { default: NodemailerProvider } = await import('../provider.nodemailer.js');

describe('NodemailerProvider unit tests:', () => {
  let provider;
  let sendMailMock;

  beforeEach(() => {
    jest.clearAllMocks();
    sendMailMock = jest.fn();
    nodemailer.createTransport.mockReturnValue({ sendMail: sendMailMock });
    provider = new NodemailerProvider({ host: 'smtp.example.com', port: 587 });
  });

  test('should create a nodemailer transport with provided options', () => {
    expect(nodemailer.createTransport).toHaveBeenCalledWith({ host: 'smtp.example.com', port: 587 });
  });

  test('should send an email without attachments', async () => {
    const mockResult = { messageId: 'msg_123' };
    sendMailMock.mockResolvedValue(mockResult);

    const result = await provider.send({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test',
      html: '<p>Hello</p>',
    });

    expect(sendMailMock).toHaveBeenCalledWith({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test',
      html: '<p>Hello</p>',
    });
    expect(result).toEqual(mockResult);
  });

  test('should send an email with attachments', async () => {
    const mockResult = { messageId: 'msg_456' };
    sendMailMock.mockResolvedValue(mockResult);

    const csvContent = 'col1,col2\nval1,val2';
    const result = await provider.send({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test with attachment',
      html: '<p>See attached</p>',
      attachments: [{ filename: 'data.csv', content: csvContent }],
    });

    expect(sendMailMock).toHaveBeenCalledWith({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test with attachment',
      html: '<p>See attached</p>',
      attachments: [{ filename: 'data.csv', content: csvContent }],
    });
    expect(result).toEqual(mockResult);
  });

  test('should not include attachments key when attachments array is empty', async () => {
    const mockResult = { messageId: 'msg_789' };
    sendMailMock.mockResolvedValue(mockResult);

    await provider.send({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test',
      html: '<p>Hello</p>',
      attachments: [],
    });

    const calledWith = sendMailMock.mock.calls[0][0];
    expect(calledWith).not.toHaveProperty('attachments');
  });

  test('should send with Buffer attachment content', async () => {
    const mockResult = { messageId: 'msg_buf' };
    sendMailMock.mockResolvedValue(mockResult);

    const bufContent = Buffer.from('binary data');
    await provider.send({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Buffer test',
      html: '<p>Buffer</p>',
      attachments: [{ filename: 'file.bin', content: bufContent }],
    });

    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [{ filename: 'file.bin', content: bufContent }],
      }),
    );
  });
});
