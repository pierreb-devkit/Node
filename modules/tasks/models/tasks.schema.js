/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 *  Data Schema
 */
const Task = z.object({
  title: z.string({ error: 'title must be a string' }).trim().min(1),
  description: z.string().default(''),
  user: z.string().trim().default(''),
});

const TaskUpdate = Task.partial();

export default {
  Task,
  TaskUpdate,
};
