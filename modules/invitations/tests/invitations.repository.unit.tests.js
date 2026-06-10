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

  test('findByEmail queries unused + unexpired, newest first', async () => {
    exec.mockResolvedValue(null);
    await InvitationRepository.findByEmail('a@b.co');
    const filter = InvitationModel.findOne.mock.calls.at(-1)[0];
    expect(filter.email).toBe('a@b.co');
    expect(filter.usedAt).toBeNull();
    expect(filter.expiresAt).toHaveProperty('$gt');
    expect(chain.sort).toHaveBeenCalledWith('-createdAt');
  });

  test('consume atomically marks used with a usedAt:null guard', async () => {
    exec.mockResolvedValue({ id: 'i1', usedAt: new Date() });
    await InvitationRepository.consume('i1');
    const [filter, update] = InvitationModel.findOneAndUpdate.mock.calls.at(-1);
    expect(filter).toEqual({ _id: 'i1', usedAt: null });
    expect(update).toHaveProperty('$set.usedAt');
  });

  test('list omits the token and populates invitedBy, newest first', async () => {
    exec.mockResolvedValue([]);
    await InvitationRepository.list();
    expect(InvitationModel.find).toHaveBeenCalledWith({});
    expect(chain.select).toHaveBeenCalledWith('-token');
    expect(chain.populate).toHaveBeenCalledWith('invitedBy', 'email firstName lastName');
    expect(chain.sort).toHaveBeenCalledWith('-createdAt');
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

  test('remove deletes by id', async () => {
    exec.mockResolvedValue({ deletedCount: 1 });
    const result = await InvitationRepository.remove('i1');
    expect(InvitationModel.deleteOne).toHaveBeenCalledWith({ _id: 'i1' });
    expect(result).toEqual({ deletedCount: 1 });
  });
});
