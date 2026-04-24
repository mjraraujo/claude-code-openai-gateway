/**
 * Public surface of the runtime client: provider, hooks, fetch helper,
 * and typed domain clients. Panels should `import { ... } from
 * "@/lib/runtime/client"` rather than reaching into the individual
 * modules.
 */

export {
  RuntimeProvider,
  useRuntimeState,
  useRuntimeSelector,
  useRuntimeConnectionStatus,
  useReconnectRuntime,
  type RuntimeConnectionStatus,
  type RuntimeProviderProps,
} from "./RuntimeProvider";

export { ApiError, fetchJson, errorMessageFromBody, type FetchJsonOptions } from "./fetchJson";

export {
  agentsClient,
  autoDriveClient,
  harnessClient,
  tasksClient,
  workspaceClient,
  type CreateAgentInput,
  type CreateTaskInput,
  type CreateWorkspaceInput,
  type PatchTaskInput,
  type StartAutoDriveInput,
  type UpdateAgentInput,
} from "./clients";
