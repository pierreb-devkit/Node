// Fixture: policy file with abilities AND SubjectRegistration
/**
 * Define task abilities for authenticated users.
 * @param {Object} _user - The authenticated user (unused in fixture)
 * @param {Object} _membership - Optional organization membership (unused in fixture)
 * @param {Object} context - CASL ability builder context
 * @param {Function} context.can - Function to grant abilities
 * @returns {void}
 */
export function taskAbilities(_user, _membership, { can }) {
  can('read', 'Task');
}

/**
 * Register task document subject for CASL resolution.
 * @param {Object} context - Registration context
 * @param {Function} context.registerDocumentSubject - Function to register document subjects
 * @returns {void}
 */
export function taskSubjectRegistration({ registerDocumentSubject }) {
  registerDocumentSubject('task', 'Task');
}
