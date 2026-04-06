// Fixture: policy file with guestAbilities but no SubjectRegistration
/**
 * Define task abilities for guest users (fixture without SubjectRegistration).
 * @param {Object} context - CASL ability builder context
 * @param {Function} context.can - Function to grant abilities
 * @returns {void}
 */
export function taskGuestAbilities({ can }) {
  can('read', 'Task');
}
