/**
 * Typed wrappers for runtime mutation endpoints.
 *
 * Each module exposes the small handful of operations a panel needs.
 * They all funnel through `fetchJson`, so:
 *   - non-2xx responses throw `ApiError` (no more silent failures
 *     like the original `KanbanPanel.deleteCard`)
 *   - the server's `{ error }` field is surfaced as the message
 *   - cancellation is a first-class `signal` argument
 *
 * These are deliberately thin — there's no caching or optimistic
 * update logic here. The runtime SSE stream already pushes a fresh
 * snapshot moments after any mutation, so panels just await the
 * mutation and let the SSE-driven re-render reconcile UI state.
 */

import type {
  AgentState,
  AutoDriveRun,
  DriveMode,
  HarnessState,
  RufloPersona,
  Sprint,
  SubTask,
  Task,
  TaskColumn,
  Workspace,
} from "@/lib/runtime";

import { fetchJson } from "./fetchJson";

/* ─── Tasks ───────────────────────────────────────────────────────── */

export interface CreateTaskInput {
  title: string;
  column?: TaskColumn;
  tag?: string;
  workspaceId?: string | null;
}

export interface PatchTaskInput {
  id: string;
  title?: string;
  column?: TaskColumn;
  tag?: string;
  assignees?: string[];
  subtasks?: SubTask[];
  sprintId?: string | null;
  workspaceId?: string | null;
}

export const tasksClient = {
  create(input: CreateTaskInput, signal?: AbortSignal): Promise<{ task: Task } | null> {
    return fetchJson<{ task: Task }>("/api/runtime/tasks", {
      method: "POST",
      body: input,
      signal,
    });
  },
  patch(input: PatchTaskInput, signal?: AbortSignal): Promise<{ task: Task } | null> {
    return fetchJson<{ task: Task }>("/api/runtime/tasks", {
      method: "PATCH",
      body: input,
      signal,
    });
  },
  remove(id: string, signal?: AbortSignal): Promise<unknown> {
    return fetchJson("/api/runtime/tasks", {
      method: "DELETE",
      body: { id },
      signal,
    });
  },
};

/* ─── Harness ─────────────────────────────────────────────────────── */

export const harnessClient = {
  patch(
    patch: Partial<HarnessState>,
    signal?: AbortSignal,
  ): Promise<{ harness: HarnessState } | null> {
    return fetchJson<{ harness: HarnessState }>("/api/runtime/harness", {
      method: "PATCH",
      body: patch,
      signal,
    });
  },
};

/* ─── Agents ──────────────────────────────────────────────────────── */

export interface CreateAgentInput {
  id?: string;
  name: string;
  status?: AgentState["status"];
  skill: string;
  department?: string | null;
  model?: string | null;
}

export interface UpdateAgentInput {
  id: string;
  name?: string;
  status?: AgentState["status"];
  skill?: string;
  department?: string | null;
  model?: string | null;
}

export const agentsClient = {
  create(input: CreateAgentInput, signal?: AbortSignal): Promise<{ agent: AgentState } | null> {
    return fetchJson<{ agent: AgentState }>("/api/runtime/agents", {
      method: "POST",
      body: input,
      signal,
    });
  },
  update(input: UpdateAgentInput, signal?: AbortSignal): Promise<{ agent: AgentState } | null> {
    return fetchJson<{ agent: AgentState }>("/api/runtime/agents", {
      method: "PUT",
      body: input,
      signal,
    });
  },
  remove(id: string, signal?: AbortSignal): Promise<unknown> {
    return fetchJson("/api/runtime/agents", {
      method: "DELETE",
      body: { id },
      signal,
    });
  },
};

/* ─── Auto-drive ──────────────────────────────────────────────────── */

export interface StartAutoDriveInput {
  goal: string;
  maxSteps?: number;
  driveMode?: DriveMode;
  persona?: RufloPersona;
  model?: string;
}

export const autoDriveClient = {
  start(
    input: StartAutoDriveInput,
    signal?: AbortSignal,
  ): Promise<{ run: AutoDriveRun; mode: DriveMode } | null> {
    return fetchJson<{ run: AutoDriveRun; mode: DriveMode }>(
      "/api/runtime/auto-drive",
      { method: "POST", body: { action: "start", ...input }, signal },
    );
  },
  stop(signal?: AbortSignal): Promise<unknown> {
    return fetchJson("/api/runtime/auto-drive", {
      method: "POST",
      body: { action: "stop" },
      signal,
    });
  },
  forceStop(signal?: AbortSignal): Promise<unknown> {
    return fetchJson("/api/runtime/auto-drive", {
      method: "POST",
      body: { action: "force-stop" },
      signal,
    });
  },
};

/* ─── Workspaces ──────────────────────────────────────────────────── */

export interface CreateWorkspaceInput {
  name: string;
  activate?: boolean;
}

export const workspaceClient = {
  create(
    input: CreateWorkspaceInput,
    signal?: AbortSignal,
  ): Promise<{ workspace: Workspace } | null> {
    return fetchJson<{ workspace: Workspace }>("/api/runtime/workspaces", {
      method: "POST",
      body: input,
      signal,
    });
  },
  activate(id: string, signal?: AbortSignal): Promise<unknown> {
    return fetchJson(`/api/runtime/workspaces/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { activate: true },
      signal,
    });
  },
};

/* ─── Sprints (read-only consumer; writes go through SSE-reconciled tasks) ──── */

export type { Sprint };
