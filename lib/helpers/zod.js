/**
 * Module dependencies
 */
import zxcvbn from 'zxcvbn';
import config from '../../config/index.js';
import { z } from 'zod';

/**
 * @desc Zod superRefine for zxcvbn password strength
 */
const passwordRefinement = (val, ctx) => {
  if (config.zxcvbn.forbiddenPasswords.includes(val)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'password is too common' });
  } else if (zxcvbn(val).score < config.zxcvbn.minimumScore) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `password must have a strength of at least ${config.zxcvbn.minimumScore}` });
  }
};

export default { passwordRefinement };
