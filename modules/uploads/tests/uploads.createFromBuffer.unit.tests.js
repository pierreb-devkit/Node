/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for uploads createFromBuffer service
 */
describe('Uploads createFromBuffer unit tests:', () => {
  let UploadsService;
  let mockGridfs;
  let mockConfig;

  const fakeFile = {
    _id: '507f1f77bcf86cd799439011',
    filename: 'abc123.jpeg',
    contentType: 'image/jpeg',
    metadata: { kind: 'snapshot', contentType: 'image/jpeg' },
    length: 1024,
  };

  beforeEach(async () => {
    jest.resetModules();

    mockGridfs = {
      createFromBuffer: jest.fn().mockResolvedValue(fakeFile),
      getStorage: jest.fn(),
    };

    mockConfig = {
      uploads: {
        snapshot: {
          kind: 'snapshot',
          formats: ['image/jpeg', 'image/png'],
          limits: { fileSize: 5 * 1024 * 1024 },
        },
        avatar: {
          kind: 'avatar',
          formats: ['image/png', 'image/jpeg', 'image/jpg', 'image/gif'],
          limits: { fileSize: 1 * 1024 * 1024 },
        },
      },
    };

    jest.unstable_mockModule('../../../lib/services/gridfs.js', () => ({
      default: mockGridfs,
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    jest.unstable_mockModule('../../../lib/services/multer.js', () => ({
      default: { generateFileName: jest.fn() },
    }));

    jest.unstable_mockModule('../repositories/uploads.repository.js', () => ({
      default: {
        get: jest.fn(),
        getStream: jest.fn(),
        update: jest.fn(),
        remove: jest.fn(),
      },
    }));

    UploadsService = (await import('../services/uploads.service.js')).default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should store a valid JPEG buffer and return upload document', async () => {
    const buffer = Buffer.alloc(1024);
    const result = await UploadsService.createFromBuffer(buffer, 'image/jpeg', 'snapshot', { user: '507f1f77bcf86cd799439011' });

    expect(result).toBeDefined();
    expect(result.contentType).toBe('image/jpeg');
    expect(result.metadata.kind).toBe('snapshot');
    expect(mockGridfs.createFromBuffer).toHaveBeenCalledTimes(1);

    const [buf, filename, contentType, metadata] = mockGridfs.createFromBuffer.mock.calls[0];
    expect(buf).toBe(buffer);
    expect(filename).toMatch(/^[a-f0-9]{64}\.jpeg$/);
    expect(contentType).toBe('image/jpeg');
    expect(metadata.kind).toBe('snapshot');
    expect(metadata.user).toBe('507f1f77bcf86cd799439011');
  });

  test('should store a valid PNG buffer and return upload document', async () => {
    const buffer = Buffer.alloc(512);
    mockGridfs.createFromBuffer.mockResolvedValue({ ...fakeFile, contentType: 'image/png' });

    const result = await UploadsService.createFromBuffer(buffer, 'image/png', 'snapshot');
    expect(result).toBeDefined();
    expect(result.contentType).toBe('image/png');

    const [, filename] = mockGridfs.createFromBuffer.mock.calls[0];
    expect(filename).toMatch(/^[a-f0-9]{64}\.png$/);
  });

  test('should throw error when buffer exceeds size limit', async () => {
    const oversizedBuffer = Buffer.alloc(6 * 1024 * 1024); // 6 MB > 5 MB limit

    await expect(
      UploadsService.createFromBuffer(oversizedBuffer, 'image/jpeg', 'snapshot'),
    ).rejects.toThrow(/buffer size .* exceeds limit/);

    expect(mockGridfs.createFromBuffer).not.toHaveBeenCalled();
  });

  test('should throw error when content type is not allowed for kind', async () => {
    const buffer = Buffer.alloc(1024);

    await expect(
      UploadsService.createFromBuffer(buffer, 'application/pdf', 'snapshot'),
    ).rejects.toThrow(/content type .* not allowed/);

    expect(mockGridfs.createFromBuffer).not.toHaveBeenCalled();
  });

  test('should throw error when kind is unknown', async () => {
    const buffer = Buffer.alloc(1024);

    await expect(
      UploadsService.createFromBuffer(buffer, 'image/jpeg', 'unknown'),
    ).rejects.toThrow(/unknown kind/);

    expect(mockGridfs.createFromBuffer).not.toHaveBeenCalled();
  });

  test('should throw error when buffer is null or undefined', async () => {
    await expect(
      UploadsService.createFromBuffer(null, 'image/jpeg', 'snapshot'),
    ).rejects.toThrow(/buffer is required/);

    await expect(
      UploadsService.createFromBuffer(undefined, 'image/jpeg', 'snapshot'),
    ).rejects.toThrow(/buffer is required/);

    expect(mockGridfs.createFromBuffer).not.toHaveBeenCalled();
  });

  test('should throw error when buffer is not a Buffer', async () => {
    await expect(
      UploadsService.createFromBuffer('not a buffer', 'image/jpeg', 'snapshot'),
    ).rejects.toThrow(/buffer is required/);

    expect(mockGridfs.createFromBuffer).not.toHaveBeenCalled();
  });

  test('should throw error when kind has no formats configured', async () => {
    mockConfig.uploads.broken = { kind: 'broken', limits: { fileSize: 1024 } };

    await expect(
      UploadsService.createFromBuffer(Buffer.alloc(10), 'image/jpeg', 'broken'),
    ).rejects.toThrow(/no formats configured/);

    expect(mockGridfs.createFromBuffer).not.toHaveBeenCalled();
  });
});
