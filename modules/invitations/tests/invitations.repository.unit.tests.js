import { jest } from '@jest/globals';

/**
 * The repository resolves `mongoose.model('Invitation')` at import time, so mongoose
 * is mocked to hand back a model whose query builders return chainable thenables.
 */
const exec = jest.fn();
const chain = {
  select: jest.fn(() => chain),
  populate: jest.fn(() => chain),
  sort: jest.fn(() => chain),
  lean: jest.fn(() => chain),
  exec,
};
const save = jest.fn();
const InvitationModel = jest.fn(function InvitationModel(doc) {
  Object.assign(this, doc);
  this.save = save;
});
InvitationModel.findOne = jest.fn(() => chain);
InvitationModel.findOneAndUpdate = jest.fn(() => chain);
InvitationModel.find = jest.fn(() => chain);
InvitationModel.findById = jest.fn(() => chain);
InvitationModel.deleteOne = jest.fn(() => chain);
InvitationModel.updateMany = jest.fn(() => chain);
InvitationModel.countDocuments = jest.fn(() => chain);

const isValid = jest.fn(() => true);

jest.unstable_mockModule('mongoose', () => ({
  default: {
    model: jest.fn(() => InvitationModel),
    Types: { ObjectId: { isValid } },
  },
}));

const InvitationRepository = (await import('../repositories/invitations.repository.js')).default;

beforeEach(() => {
  jest.clearAllMocks();
  exec.mockReset();
  save.mockReset();
  isValid.mockReturnValue(true);
});

describe('InvitationRepository', () => {
  test('create persists a new document via .save()', async () => {
    save.mockResolvedValue({ id: 'i1' });
    const result = await InvitationRepository.create({ email: 'a@b.co', token: 't', expiresAt: new Date(), invitedBy: null });
    expect(InvitationModel).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: 'i1' });
  });

  test('findByToken queries by token', async () => {
    exec.mockResolvedValue({ id: 'i1', token: 't' });
    const result = await InvitationRepository.findByToken('t');
    expect(InvitationModel.findOne).toHaveBeenCalledWith({ token: 't' });
    expect(result).toEqual({ id: 'i1', token: 't' });
  });

  test('findByEmail queries pending + unconsumed + not-in-flight + unexpired, newest first (E2/E8)', async () => {
    exec.mockResolvedValue(null);
    await InvitationRepository.findByEmail('a@b.co');
    const filter = InvitationModel.findOne.mock.calls.at(-1)[0];
    expect(filter.email).toBe('a@b.co');
    expect(filter.status).toBe('pending'); // E8: only pending opens the gate
    expect(filter.usedAt).toBeNull();
    expect(filter.consumingAt).toBeNull(); // E2: exclude claimed-but-unfinalized
    expect(filter.expiresAt).toHaveProperty('$gt');
    expect(chain.sort).toHaveBeenCalledWith('-createdAt');
  });

  test('claim atomically stamps consumingAt with a token+pending+unclaimed+unused+unexpired guard (E2)', async () => {
    exec.mockResolvedValue({ id: 'i1', consumingAt: new Date() });
    await InvitationRepository.claim('tok');
    const [filter, update] = InvitationModel.findOneAndUpdate.mock.calls.at(-1);
    // Self-contained CAS: the filter rejects already-used, expired, or in-flight invites
    // so a race between findValid and claim cannot bypass expiry or single-use (E2).
    expect(filter.token).toBe('tok');
    expect(filter.status).toBe('pending');
    expect(filter.consumingAt).toBeNull();
    expect(filter.usedAt).toBeNull();
    expect(filter.expiresAt).toHaveProperty('$gt'); // unexpired guard
    expect(update).toHaveProperty('$set.consumingAt');
  });

  test('finalize marks accepted+used guarded on not-yet-accepted, works claimed OR unclaimed (E2)', async () => {
    exec.mockResolvedValue({ id: 'i1', status: 'accepted' });
    await InvitationRepository.finalize('i1', 'u1');
    const [filter, update] = InvitationModel.findOneAndUpdate.mock.calls.at(-1);
    expect(filter._id).toBe('i1');
    expect(filter.acceptedAt).toBeNull(); // idempotent single-accept guard
    expect(filter.status).toEqual({ $ne: 'revoked' });
    // Intentionally does NOT require consumingAt — the OAuth path never claims.
    expect(filter.consumingAt).toBeUndefined();
    expect(update.$set.status).toBe('accepted');
    expect(update.$set.acceptedUserId).toBe('u1');
    expect(update.$set).toHaveProperty('acceptedAt');
    expect(update.$set).toHaveProperty('usedAt');
    expect(update.$unset).toEqual({ consumingAt: 1 }); // clears any claim stamp
  });

  test('release clears consumingAt guarded on not-yet-accepted (E2)', async () => {
    exec.mockResolvedValue({ id: 'i1' });
    await InvitationRepository.release('i1');
    const [filter, update] = InvitationModel.findOneAndUpdate.mock.calls.at(-1);
    expect(filter).toEqual({ _id: 'i1', acceptedAt: null });
    expect(update).toEqual({ $unset: { consumingAt: 1 } });
  });

  test('releaseStaleClaims clears consumingAt for stale, never-finalized claims (E2 sweep)', async () => {
    exec.mockResolvedValue({ modifiedCount: 3 });
    const cutoff = new Date(Date.now() - 999000);
    await InvitationRepository.releaseStaleClaims(cutoff);
    const [filter, update] = InvitationModel.updateMany.mock.calls.at(-1);
    expect(filter.consumingAt).toEqual({ $ne: null, $lt: cutoff });
    expect(filter.acceptedAt).toBeNull();
    expect(update).toEqual({ $unset: { consumingAt: 1 } });
  });

  test('list omits the token and populates invitedBy, newest first', async () => {
    exec.mockResolvedValue([]);
    await InvitationRepository.list();
    expect(InvitationModel.find).toHaveBeenCalledWith({});
    expect(chain.select).toHaveBeenCalledWith('-token');
    expect(chain.populate).toHaveBeenCalledWith('invitedBy', 'email firstName lastName');
    expect(chain.sort).toHaveBeenCalledWith('-createdAt');
  });

  test('list({ invitedBy }) threads the filter (#3833 non-admin scoping), token still stripped', async () => {
    exec.mockResolvedValue([]);
    await InvitationRepository.list({ invitedBy: 'u1' });
    expect(InvitationModel.find).toHaveBeenCalledWith({ invitedBy: 'u1' });
    expect(chain.select).toHaveBeenCalledWith('-token');
    expect(chain.populate).toHaveBeenCalledWith('invitedBy', 'email firstName lastName');
    expect(chain.sort).toHaveBeenCalledWith('-createdAt');
  });

  test('countByInvitedBy counts across ALL statuses for a given inviter (#3986)', async () => {
    exec.mockResolvedValue(5);
    const result = await InvitationRepository.countByInvitedBy('u1');
    // No status filter — the lifetime cap must not reset on expire/revoke.
    expect(InvitationModel.countDocuments).toHaveBeenCalledWith({ invitedBy: 'u1' });
    expect(result).toBe(5);
  });

  test('findAccepted scans status:accepted lean with the minimal referral projection (#3842)', async () => {
    exec.mockResolvedValue([{ _id: 'i1', invitedBy: 'u1', acceptedUserId: 'u2' }]);
    const result = await InvitationRepository.findAccepted();
    // Scans ALL accepted (not invitedBy:{$ne:null}) — referee grants exist without an inviter.
    expect(InvitationModel.find).toHaveBeenCalledWith({ status: 'accepted' }, { invitedBy: 1, acceptedUserId: 1 });
    expect(chain.lean).toHaveBeenCalled();
    expect(result).toEqual([{ _id: 'i1', invitedBy: 'u1', acceptedUserId: 'u2' }]);
  });

  test('findByAcceptedUserId resolves the accepted invite consumed by a user, lean + minimal projection (#3844)', async () => {
    exec.mockResolvedValue({ _id: 'i1', invitedBy: 'u1', acceptedUserId: 'u2' });
    const result = await InvitationRepository.findByAcceptedUserId('u2');
    expect(InvitationModel.findOne).toHaveBeenCalledWith(
      { status: 'accepted', acceptedUserId: 'u2' },
      { invitedBy: 1, acceptedUserId: 1 },
    );
    expect(chain.lean).toHaveBeenCalled();
    expect(result).toEqual({ _id: 'i1', invitedBy: 'u1', acceptedUserId: 'u2' });
  });

  test('findByAcceptedUserId returns null for an invalid ObjectId without hitting the DB (#3844)', async () => {
    isValid.mockReturnValue(false);
    const result = await InvitationRepository.findByAcceptedUserId('not-an-id');
    expect(result).toBeNull();
    expect(InvitationModel.findOne).not.toHaveBeenCalled();
  });

  test('get returns null for an invalid ObjectId without hitting the DB', async () => {
    isValid.mockReturnValue(false);
    const result = await InvitationRepository.get('not-an-id');
    expect(result).toBeNull();
    expect(InvitationModel.findById).not.toHaveBeenCalled();
  });

  test('get queries by id for a valid ObjectId', async () => {
    isValid.mockReturnValue(true);
    exec.mockResolvedValue({ id: 'i1' });
    const result = await InvitationRepository.get('i1');
    expect(InvitationModel.findById).toHaveBeenCalledWith('i1');
    expect(result).toEqual({ id: 'i1' });
  });

  test('revoke soft-deletes by id GUARDED on status:pending (E8 + revoke-guard), not deleteOne', async () => {
    exec.mockResolvedValue({ id: 'i1', status: 'revoked' });
    const result = await InvitationRepository.revoke('i1');
    const [filter, update] = InvitationModel.findOneAndUpdate.mock.calls.at(-1);
    // An accepted invite must never flip to revoked — that would silently drop
    // it out of the accepted set findAccepted() scans for referral attribution.
    expect(filter).toEqual({ _id: 'i1', status: 'pending' });
    expect(update.$set.status).toBe('revoked');
    expect(update.$set).toHaveProperty('revokedAt');
    expect(InvitationModel.deleteOne).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'i1', status: 'revoked' });
  });
});
