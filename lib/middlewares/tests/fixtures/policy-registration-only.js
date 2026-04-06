// Fixture: policy file with SubjectRegistration only (no abilities)
/**
 * Register task document subject for CASL resolution.
 * @param {Object} context - Registration context
 * @param {Function} context.registerDocumentSubject - Function to register document subjects
 * @returns {void}
 */
export function taskSubjectRegistration({ registerDocumentSubject }) {
  registerDocumentSubject('task', 'Task');
}
