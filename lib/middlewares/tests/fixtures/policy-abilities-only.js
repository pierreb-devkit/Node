// Fixture: policy file with abilities but no SubjectRegistration
/**
 * Define task abilities for authenticated users (fixture without SubjectRegistration).
 * @param {Object} _user - The authenticated user (unused in fixture)
 * @param {Object} _membership - Optional organization membership (unused in fixture)
 * @param {Object} context - CASL ability builder context
 * @param {Function} context.can - Function to grant abilities
 * @returns {void}
 */
export function taskAbilities(_user, _membership, { can }) {
  can('read', 'Task');
}
