/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for the uploads removeByOrganization service (org-removal cleanup).
 */
describe('Uploads removeByOrganization unit tests:', () => {
  let UploadsService;
  let mockRepository;

  beforeEach(async () => {
    jest.resetModules();

    mockRepository = { removeByOrganization: jest.fn().mockResolvedValue({ deleted: 3 }) };

    jest.unstable_mockModule('../repositories/uploads.gridfs.repository.js', () => ({
      default: { createFromBuffer: jest.fn(), getStorage: jest.fn() },
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: { uploads: {} } }));
    jest.unstable_mockModule('../repositories/uploads.repository.js', () => ({ default: mockRepository }));

    UploadsService = (await import('../services/uploads.service.js')).default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('delegates a valid organization id to the repository', async () => {
    await expect(UploadsService.removeByOrganization('507f1f77bcf86cd799439011')).resolves.toEqual({ deleted: 3 });
    expect(mockRepository.removeByOrganization).toHaveBeenCalledWith('507f1f77bcf86cd799439011');
  });

  test.each([[undefined], [null], [''], ['not-an-id']])(
    'throws and deletes nothing for an invalid organization id (%p)',
    async (orgId) => {
      await expect(UploadsService.removeByOrganization(orgId)).rejects.toThrow('invalid organization id');
      expect(mockRepository.removeByOrganization).not.toHaveBeenCalled();
    },
  );
});
