import { z } from "zod";

/** Task types (expand later) */
export const TaskType = z.enum(["email_triage", "calendar_brief"]);
export type TaskType = z.infer<typeof TaskType>;

export const CreateTask = z.object({
  type: TaskType,
  org_id: z.string().uuid(),
  user_id: z.string().uuid(),
  input: z.record(z.any()).default({}),
});
export type CreateTask = z.infer<typeof CreateTask>;

export const RunEventLevel = z.enum(["info", "warn", "error"]);
export type RunEventLevel = z.infer<typeof RunEventLevel>;

export type RunEvent = {
  run_id: string;
  ts: number;
  level: RunEventLevel;
  message: string;
  data?: any;
};
