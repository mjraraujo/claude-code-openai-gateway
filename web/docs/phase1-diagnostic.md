# Phase 1 — Deep Code Review & Conceptual Validation

## Scope reviewed
- Shell/layout orchestration: `src/components/claude-codex/index.tsx`, `MobileShell.tsx`, `WorkspaceCenter.tsx`, `SplitPane.tsx`.
- Major product panels: `KanbanPanel.tsx`, `AgentsPanel.tsx`, `ChatDock.tsx`, `WorkspaceView.tsx`, `TerminalTabs.tsx`.
- Runtime/store and drive orchestration: `src/lib/runtime/store.ts`, `drive.ts`, `index.ts`.

## What is currently working well
1. **Core runtime model is coherent and strongly typed.**
   - `RuntimeState` models agents, departments, auto-drive, tasks, sprints, workspaces, and SDLC state in one place.
   - Store update/snapshot APIs and event emission provide a practical in-process state backbone.

2. **Terminal architecture has good foundations.**
   - Terminal tab behavior is isolated into pure helpers (`terminalTabs.ts`) with good unit coverage.
   - PTY session persistence support exists and avoids re-spawning interactive sessions on reload.

3. **Filesystem/editor experience has strong safety and resilience primitives.**
   - Workspace file APIs are paired with restore/dirty/conflict logic in `WorkspaceView`.
   - FS watch events are already wired into explorer updates and external modification awareness.

4. **Desktop shell supports advanced workflows.**
   - Resizable/collapsible left, center, right rails and terminal docking are implemented.
   - The split-pane primitive includes pointer + keyboard interactions and clamping.

## Key conceptual issues to improve
1. **State subscription is fragmented across many components.**
   Multiple panels independently open `EventSource('/api/runtime/state')`.
   This creates duplicated websocket/SSE consumers, repeated parsing logic, and divergent loading/error handling.

2. **UI composition is powerful but overly monolithic.**
   Top-level shell and major panels combine view rendering + API orchestration + domain logic in single components, increasing coupling and reducing testability.

3. **Tab/navigation model is inconsistent across desktop and mobile.**
   - Desktop has nested tabs (workspace center + right rail + terminal tabs).
   - Mobile has a separate tab system and default starts on `workspace`.
   - The mental model for “where terminal/chat/agents live” changes by breakpoint.

4. **Network mutation patterns are repeated ad hoc.**
   Similar `busy/error/fetch` flows are re-implemented in each panel, causing drift in error handling quality and introducing latent bugs.

## Bugs / anti-patterns / bottlenecks identified
1. **Potential stale-state send race in chat.**
   In `ChatDock.send`, request payload history is built from component state and then state is mutated; rapid sends can still race if not serialized by design.

2. **Silent failure on task delete flow.**
   `KanbanPanel.deleteCard` does not assert `res.ok`; backend errors can be ignored while UI appears successful.

3. **Global busy flags can lock unrelated actions.**
   Large panels use single `busy` booleans for heterogeneous operations (e.g., add/edit/delete/move), creating coarse UI lock behavior.

4. **Repeated SSE listeners likely increase resource use and cognitive complexity.**
   Status bar, Kanban, Agents, Chat, and Sprint panels each subscribe independently.

5. **Tab state is mostly local and duplicated by context.**
   Terminal tabs persist well, but workspace/rail/mobile tab state is split across components, making cross-layout continuity harder.

## Proposed target conceptual architecture (v2)
### 1) Shared app state + event transport layer
- Introduce a single runtime client module:
  - one `EventSource` connection,
  - normalized typed event parsing,
  - React context store (`RuntimeProvider`) with selectors.
- Panels consume `useRuntimeSelector(...)` instead of creating their own subscriptions.

### 2) Service layer for mutations
- Add typed domain clients (`tasksClient`, `harnessClient`, `agentsClient`, `autoDriveClient`, `workspaceClient`) with:
  - centralized `fetchJson` + error normalization,
  - optimistic update conventions,
  - cancellation/retry rules where useful.

### 3) UI architecture split
- **Container components (smart):** data fetch/subscriptions, command handlers, view models.
- **Presentational components (dumb):** stateless rendering + callbacks only.
- Lift panel-level side effects (SSE, repeated fetch wiring) out of visual components.

### 4) Navigation architecture
- Create a unified `ShellNavigationState` that defines:
  - primary area (Tasks / Workspace / Agents / Chat),
  - workspace sub-view (Editor / Side-by-Side / Browser / Amigos),
  - terminal visibility + active terminal tab.
- Desktop and mobile both project from the same navigation state model (different layouts, same semantics).

### 5) Performance and UX guardrails
- Keep-lazy-mount strategy for expensive surfaces (Monaco, xterm) but with explicit cache policies.
- Replace coarse panel `busy` flags with operation-scoped pending states.
- Standardize error toasts/banners and success affordances.

## Recommended migration order
1. Build runtime provider + mutation service layer (no UI redesign yet).
2. Refactor one panel at a time (Kanban → Agents → Chat → Workspace) to container/presentational split.
3. Introduce unified navigation model and adapt desktop/mobile shells.
4. Polish visual language and accessibility in Phase 2 redesign implementation.
