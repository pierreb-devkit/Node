// Fixture: policy file with abilities AND SubjectRegistration
export function taskAbilities(user, membership, { can }) {
  can('read', 'Task');
}

export function taskSubjectRegistration({ registerDocumentSubject }) {
  registerDocumentSubject('task', 'Task');
}
