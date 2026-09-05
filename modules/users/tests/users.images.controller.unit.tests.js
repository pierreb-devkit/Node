/**
 * Module dependencies.
 */
import { jest, describe, test, expect } from '@jest/globals';

/**
 * Loads a fresh users.images.controller.js instance with its dependencies
 * mocked. `AppError` and `errors.getMessage` intentionally stay REAL — this
 * suite proves the actual curated `details` shape the real `AppError` class
 * produces, not a stand-in.
 * @returns {Promise<{UsersImagesController: Object, mockResponsesError: import('@jest/globals').Mock, errorSink: import('@jest/globals').Mock}>}
 */
const loadController = async () => {
  jest.resetModules();

  const errorSink = jest.fn();
  const mockResponsesError = jest.fn().mockReturnValue(errorSink);
  jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
    default: { success: jest.fn().mockReturnValue(jest.fn()), error: mockResponsesError },
  }));
  jest.unstable_mockModule('../../../lib/helpers/errors.js', () => ({
    default: { getMessage: jest.fn((err) => err?.message || 'error') },
  }));
  jest.unstable_mockModule('../../uploads/services/uploads.service.js', () => ({
    default: { remove: jest.fn().mockResolvedValue(undefined) },
  }));
  jest.unstable_mockModule('../services/users.service.js', () => ({
    default: { update: jest.fn() },
  }));

  const { default: UsersImagesController } = await import('../controllers/users.images.controller.js');
  return { UsersImagesController, mockResponsesError, errorSink };
};

/**
 * Unit tests — issue #4059 review item 3. `updateAvatar` was the NINTH raw-
 * forward site (the issue's "eight call sites" framing missed it): a real
 * Multer error (which carries its own `code` like `LIMIT_FILE_SIZE` and a
 * `field`, on top of `message`) was handed wholesale to `AppError.details`.
 * Curated the same way as the other eight sites: `{ message: err.message }`
 * only.
 */
describe('users.images.controller updateAvatar — multerErr curation (issue #4059, ninth site):', () => {
  test('curates details to { message } only — the raw Multer error is never forwarded wholesale', async () => {
    const { UsersImagesController, errorSink } = await loadController();
    const rawMulterErr = Object.assign(new Error('File too large'), {
      code: 'LIMIT_FILE_SIZE',
      field: 'avatar',
      storageErrors: [],
    });
    const req = { multerErr: rawMulterErr, user: {} };
    const res = {};

    await UsersImagesController.updateAvatar(req, res);

    expect(errorSink).toHaveBeenCalledTimes(1);
    const caught = errorSink.mock.calls[0][0];
    expect(caught.details).toEqual({ message: 'File too large' });
    expect(Object.keys(caught.details)).toEqual(['message']);
    expect(caught.details.code).toBeUndefined();
    expect(caught.details.field).toBeUndefined();
    expect(caught.details.storageErrors).toBeUndefined();
  });
});
