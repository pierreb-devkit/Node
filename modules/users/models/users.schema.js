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
  additionalProvidersData: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
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
  // Referral substrate (#5) — `referredBy` is DELIBERATELY NOT declared here.
  // This is a server-only field set on invite acceptance (the invitations finalize
  // seam, via UserService.updateById, which bypasses Zod + the update whitelist).
  //
  // Architecture note: the signup route validates the body with `model.isValid(SignupUser)`
  // (not `User`), and for POST replaces req.body with the full Zod output — so only fields
  // declared on `SignupUser` reach the controller. `SignupUser` deliberately accepts
  // `referredBy` (to avoid a .strict() 422 on invite-path clients) but the controller
  // DELETES it before UserService.create so a client can never self-assign a referrer.
  // See SignupUser JSDoc below and the controller's defense-in-depth strip for details.
  //
  // `User` still omits `referredBy` here to protect the `UserUpdate`/PUT surface and the
  // OAuth-bootstrap path (both validated with `User`). Do NOT add `referredBy` to `User`.
  // The Mongoose model + the updateById raw path are all the server needs to persist it.
  // When a future feature needs to READ/EXPOSE `referredBy`, do it via a response
  // projection / the read whitelist — NEVER by adding it to this schema.
  // others
  complementary: z.record(z.string(), z.unknown()).nullable().optional(),
});

const UserUpdate = User.partial();

/**
 * Public signup write surface.
 *
 * The signup route validates the body with `model.isValid(...)`, and for a POST that
 * REPLACES req.body with the FULL Zod output — so EVERY field declared on the parsed
 * schema becomes client-writable on signup. Validating signup with the full `User`
 * schema therefore lets a public client self-assign server-owned fields
 * (emailVerified, providerData/additionalProvidersData, reset/verification tokens,
 * lockout counters, roles) — a mass-assignment hole: emailVerified:true self-verifies
 * and defeats the OAuth-annexation guard, and a pre-seeded providerData enables hijack.
 *
 * `SignupUser` exposes ONLY the fields a public signup may legitimately set — the same
 * safe surface encoded by `config.whitelists.users.default` / `.update` — and is
 * `.strict()`, so any unknown / server-owned key is REJECTED (422) instead of silently
 * persisted. Field DEFAULTS mirror `User` exactly (empty-string defaults, password
 * `.default('')` + the shared strength refinement read from config) so the
 * password-less / OAuth-bootstrap signup paths keep working. The controller adds a
 * defense-in-depth strip on top, because the service layer does no whitelisting.
 *
 * `provider` is accepted (a local signup legitimately carries `provider:'local'`); it
 * is NOT a privilege field on its own — without a client-writable providerData (omitted
 * here) and with emailVerified forced false in the controller, a chosen provider value
 * cannot annex an OAuth identity. `roles` is intentionally OMITTED: the controller
 * forces `['user']`.
 *
 * `referredBy` is accepted (the invitation P8a test — and real clients on an invite
 * flow — may send it to prove the server ignores it) but DELETED by the controller
 * before UserService.create; the server always sets referredBy via the invite finalize
 * seam (invitations module, not the signup body). Accepting it here prevents a .strict()
 * 422 on invite-path signups while still guaranteeing a client can never self-assign.
 */
const SignupUser = z.object({
  firstName: User.shape.firstName,
  lastName: User.shape.lastName,
  bio: User.shape.bio,
  position: User.shape.position,
  email: User.shape.email,
  avatar: User.shape.avatar,
  provider: User.shape.provider,
  password: User.shape.password,
  terms: User.shape.terms,
  complementary: User.shape.complementary,
  referredBy: z.string().optional(),
}).strict();

export default {
  User,
  UserUpdate,
  SignupUser,
};
