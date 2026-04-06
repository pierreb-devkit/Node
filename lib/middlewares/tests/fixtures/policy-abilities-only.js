// Fixture: policy file with abilities but no SubjectRegistration
export function taskAbilities(user, membership, { can }) {
  can('read', 'Task');
}
