/**
 * Runtime entry point. Importing this module ensures the cron
 * scheduler is started exactly once. Route handlers that touch the
 * store should import from here rather than `./store` directly so
 * the side-effect runs.
 */

import { startCronOnce } from "./cron";

startCronOnce();

export {
  getStore,
  isValidModelId,
  isValidPersona,
  newId,
  normalizeSubtasks,
  personaAgentId,
  MAX_SUBTASK_TITLE_LENGTH,
  MAX_SUBTASKS_PER_TASK,
  VALID_PERSONAS,
} from "./store";
export type {
  AgentState,
  AgentStatus,
  AutoDriveRun,
  AutoDriveStep,
  AutoDriveStatus,
  CronJob,
  Department,
  HarnessState,
  RufloPersona,
  RuntimeState,
  SubTask,
  Task,
  TaskColumn,
} from "./store";
export { startAutoDrive, stopAutoDrive, forceClearAutoDrive } from "./drive";
export { parseSchedule } from "./cron";
