/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 * Admin create payload — only email is client-supplied; token/expiry are server-set.
 */
const Invitation = z.object({
  email: z.string().email(),
});

export default { Invitation };
