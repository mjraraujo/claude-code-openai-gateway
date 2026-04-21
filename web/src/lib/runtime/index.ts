/**
 * Runtime entry point. Importing this module ensures the cron
 * scheduler is started exactly once. Route handlers that touch the
 * store should import from here rather than `./store` directly so
 * the side-effect runs.
 */

import { startCronOnce } from "./cron";

startCronOnce();

export { getStore, isValidModelId, newId } from "./store";
export type {
  AgentState,
  AgentStatus,
  AutoDriveRun,
  AutoDriveStep,
  AutoDriveStatus,
  CronJob,
  Department,
  HarnessState,
  RuntimeState,
  Task,
  TaskColumn,
} from "./store";
export { startAutoDrive, stopAutoDrive } from "./drive";
export { parseSchedule } from "./cron";
