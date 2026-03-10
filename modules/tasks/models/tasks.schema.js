/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 *  Data Schema
 */
const Task = z.object({
  title: z.string().trim().min(1),
  description: z.string().default(''),
  user: z.string().trim().default(''),
  organizationId: z.string().trim().optional(),
});

const TaskUpdate = Task.partial();

export default {
  Task,
  TaskUpdate,
};
