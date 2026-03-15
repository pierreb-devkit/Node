/**
 * Serialize CASL abilities to a JSON-safe array compatible with createMongoAbility().
 * @param {import('@casl/ability').Ability} ability - The CASL ability instance
 * @returns {Array<{action: string, subject: string, conditions?: Object, inverted?: boolean}>} Array of serialized rules
 */
const serializeAbilities = (ability) =>
  ability.rules.map((rule) => ({
    action: rule.action,
    subject: rule.subject,
    ...(rule.conditions && { conditions: rule.conditions }),
    ...(rule.inverted && { inverted: rule.inverted }),
  }));

export default serializeAbilities;
