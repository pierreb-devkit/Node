/**
 * Module dependencies
 */
import { z } from 'zod';

import config from '../../../config/index.js';
import zodHelpers from '../../../lib/helpers/zod.js';

const names = /^[a-zA-ZàáâäãåąčćęèéêëėįìíîïłńòóôöõøùúûüųūÿýżźñçčšžÀÁÂÄÃÅĄĆČĖĘÈÉÊËÌÍÎÏĮŁŃÒÓÔÖÕØÙÚÛÜŲŪŸÝŻŹÑßÇŒÆČŠŽ∂ð ,.'-]+$/u;

/**
 * User Data Schema
 */
const User = z.object({
  firstName: z.string().regex(names).min(1).max(50).trim(),
  lastName: z.string().regex(names).min(1).max(50).trim(),
  bio: z.string().max(200).trim().optional().default(''),
  position: z.string().max(50).trim().optional().default(''),
  email: z.string().email().optional(),
  avatar: z.string().trim().default(''),
  roles: z.array(z.enum(config.whitelists.users.roles)).min(1).default(['user']),
  /* Provider */
  provider: z.string().optional(),
  providerData: z.record(z.unknown()).optional(),
  /* Password */
  password: z.string()
    .max(config.zxcvbn.maxSize)
    .default('')
    .superRefine((val, ctx) => {
      if (val === '') return; // allow empty (OAuth users / no password set)
      zodHelpers.passwordRefinement(val, ctx);
      if (val.length < config.zxcvbn.minSize) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Password length must be at least ${config.zxcvbn.minSize} characters long` });
      }
    }),
  resetPasswordToken: z.string().nullable().optional(),
  resetPasswordExpires: z.coerce.date().nullable().optional(),
  // startup requirement
  terms: z.coerce.date().nullable().optional(),
  // others
  complementary: z.record(z.unknown()).nullable().optional(),
}).strip();

const UserUpdate = User.partial();

export default {
  User,
  UserUpdate,
};
