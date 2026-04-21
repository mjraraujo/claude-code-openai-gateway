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
  isValidDriveMode,
  isValidModelId,
  isValidPersona,
  newId,
  normalizeAmigosReport,
  normalizeSubtasks,
  personaAgentId,
  INITIAL_SDLC_STATE,
  MAX_AMIGOS_FINDING_CHARS,
  MAX_AMIGOS_FINDINGS_PER_SCENARIO,
  MAX_AMIGOS_SCENARIOS_PERSISTED,
  MAX_AMIGOS_SUMMARY_CHARS,
  MAX_SUBTASK_TITLE_LENGTH,
  MAX_SUBTASKS_PER_TASK,
  VALID_DRIVE_MODES,
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
  DriveMode,
  HarnessState,
  PersistedAmigoFinding,
  PersistedAmigoResult,
  PersistedAmigosReport,
  PersistedScenarioReport,
  RufloPersona,
  RuntimeState,
  SdlcState,
  SubTask,
  Task,
  TaskColumn,
} from "./store";
export { startAutoDrive, stopAutoDrive, forceClearAutoDrive } from "./drive";
export { parseSchedule } from "./cron";
