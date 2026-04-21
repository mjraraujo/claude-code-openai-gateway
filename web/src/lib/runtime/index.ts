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
  normalizeAmigosTranscript,
  normalizeAssignees,
  normalizeIsoDate,
  normalizeSprint,
  normalizeSubtasks,
  normalizeWorkspace,
  personaAgentId,
  activeWorkspace,
  INITIAL_SDLC_STATE,
  DEFAULT_WORKSPACE_ROOT,
  WORKSPACES_PARENT_DIR,
  MAX_AMIGOS_FINDING_CHARS,
  MAX_AMIGOS_FINDINGS_PER_SCENARIO,
  MAX_AMIGOS_SCENARIOS_PERSISTED,
  MAX_AMIGOS_SUMMARY_CHARS,
  MAX_ASSIGNEES_PER_TASK,
  MAX_ASSIGNEE_LENGTH,
  MAX_SUBTASK_TITLE_LENGTH,
  MAX_SUBTASKS_PER_TASK,
  MAX_TRANSCRIPT_ENTRIES_PER_TASK,
  MAX_TRANSCRIPT_MESSAGE_CHARS,
  MAX_WORKSPACES,
  MAX_WORKSPACE_NAME,
  MAX_SPRINT_NAME,
  VALID_DRIVE_MODES,
  VALID_PERSONAS,
} from "./store";
export type {
  AgentState,
  AgentStatus,
  AmigosTranscriptEntry,
  AmigosTranscriptKind,
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
  ScaffoldRecord,
  SdlcState,
  Sprint,
  SubTask,
  Task,
  TaskColumn,
  Workspace,
} from "./store";
export { startAutoDrive, stopAutoDrive, forceClearAutoDrive } from "./drive";
export { parseSchedule } from "./cron";
