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
  firstName: z.string().max(50).trim().optional().default('')
    .refine((val) => val === '' || names.test(val), { message: 'Invalid characters in name' }),
  lastName: z.string().max(50).trim().optional().default('')
    .refine((val) => val === '' || names.test(val), { message: 'Invalid characters in name' }),
  bio: z.string().max(200).trim().optional().default(''),
  position: z.string().max(50).trim().optional().default(''),
  email: z.string().email().optional(),
  avatar: z.string().trim().default(''),
  roles: z.array(z.enum(config.whitelists.users.roles)).min(1).default(['user']),
  /* Provider */
  provider: z.string().optional(),
  providerData: z.record(z.string(), z.unknown()).optional(),
  /* Password */
  password: z.string()
    .max(config.zxcvbn.maxSize)
    .default('')
    .superRefine((val, ctx) => {
      if (val === '') return; // allow empty (OAuth users / no password set)
      zodHelpers.passwordRefinement(val, ctx);
      if (val.length < config.zxcvbn.minSize) {
        ctx.addIssue({ code: 'custom', message: `Password length must be at least ${config.zxcvbn.minSize} characters long`, input: val });
      }
    }),
  resetPasswordToken: z.string().nullable().optional(),
  resetPasswordExpires: z.coerce.date().nullable().optional(),
  /* Email verification */
  emailVerified: z.boolean().optional().default(false),
  emailVerificationToken: z.string().nullable().optional(),
  emailVerificationExpires: z.coerce.date().nullable().optional(),
  // startup requirement
  terms: z.coerce.date().nullable().optional(),
  /* Account lockout */
  lastLoginAt: z.coerce.date().nullable().optional().default(null),
  failedLoginAttempts: z.number().int().min(0).optional().default(0),
  lockUntil: z.coerce.date().nullable().optional().default(null),
  // organization context
  currentOrganization: z.string().trim().optional(),
  // others
  complementary: z.record(z.string(), z.unknown()).nullable().optional(),
});

const UserUpdate = User.partial();

export default {
  User,
  UserUpdate,
};
