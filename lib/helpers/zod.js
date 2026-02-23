/**
 * Module dependencies
 */
import zxcvbn from 'zxcvbn';
import config from '../../config/index.js';

/**
 * @desc Zod superRefine for zxcvbn password strength
 */
const passwordRefinement = (val, ctx) => {
  if (config.zxcvbn.forbiddenPasswords.includes(val)) {
    ctx.addIssue({ code: 'custom', message: 'password is too common', input: val });
  } else if (zxcvbn(val).score < config.zxcvbn.minimumScore) {
    ctx.addIssue({ code: 'custom', message: `password must have a strength of at least ${config.zxcvbn.minimumScore}`, input: val });
  }
};

export default { passwordRefinement };
