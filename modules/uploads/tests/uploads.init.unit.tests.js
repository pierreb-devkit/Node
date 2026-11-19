/**
 * Unit tests — uploads.init registers an org-removal cleanup handler that delegates to UploadsService.removeByOrganization.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockOnOrganizationRemoved = jest.fn();
const mockRemoveByOrganization = jest.fn().mockResolvedValue({ deleted: 0 });

jest.unstable_mockModule('../../organizations/lib/organizations.removal.registry.js', () => ({
  onOrganizationRemoved: mockOnOrganizationRemoved,
}));

jest.unstable_mockModule('../services/uploads.service.js', () => ({
  default: { removeByOrganization: mockRemoveByOrganization },
}));

const { default: uploadsInit } = await import('../uploads.init.js');

describe('uploads.init', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('registers a single org-removal handler at boot', async () => {
    await uploadsInit({});
    expect(mockOnOrganizationRemoved).toHaveBeenCalledTimes(1);
    expect(typeof mockOnOrganizationRemoved.mock.calls[0][0]).toBe('function');
  });

  test('the registered handler removes the uploads of the removed organization', async () => {
    await uploadsInit({});
    const handler = mockOnOrganizationRemoved.mock.calls[0][0];

    await handler({ organizationId: 'org-1', organization: { _id: 'org-1' } });

    expect(mockRemoveByOrganization).toHaveBeenCalledWith('org-1');
  });

  test('the handler surfaces a cleanup failure to the registry', async () => {
    mockRemoveByOrganization.mockRejectedValueOnce(new Error('bucket down'));
    await uploadsInit({});
    const handler = mockOnOrganizationRemoved.mock.calls[0][0];

    await expect(handler({ organizationId: 'org-1' })).rejects.toThrow('bucket down');
  });
});
