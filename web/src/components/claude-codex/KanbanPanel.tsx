"use client";

import { useEffect, useRef, useState } from "react";

import type {
  RuntimeState,
  SubTask,
  Task,
  TaskColumn,
} from "@/lib/runtime";

/** Must match the server-side constants in `lib/runtime/store.ts`. */
const MAX_SUBTASK_TITLE_LENGTH = 200;
const MAX_SUBTASKS_PER_TASK = 50;

/** Client-side id for new sub-tasks. Doesn't need to be unguessable —
 * the server re-validates every PATCH, and ids only need to be
 * locally unique within a card. `crypto.randomUUID` ships in all
 * evergreen browsers and is available in the Edge runtime too. */
function newSubtaskId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `s_${crypto.randomUUID()}`;
  }
  return `s_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

const COLUMNS: { id: TaskColumn; title: string }[] = [
  { id: "backlog", title: "Backlog" },
  { id: "active", title: "Active Sprint" },
  { id: "review", title: "In Review" },
  { id: "shipped", title: "Shipped" },
];

/** Mirrors the server-side cap in `/api/runtime/tasks` POST/PATCH. */
const MAX_TASK_TITLE_LENGTH = 200;

const METHODOLOGIES = ["Shape Up", "Scrum", "Kanban", "Spec-First"] as const;
const DEV_MODES = ["Vibe Code", "Spec Driven"] as const;

export function KanbanPanel() {
  const [state, setState] = useState<RuntimeState | null>(null);
  // Local state for the selectors mirrors the persisted harness fields.
  // We initialise from the defaults so the UI renders before the SSE
  // state arrives, then keep them in sync via the effect below.
  const [methodology, setMethodology] =
    useState<(typeof METHODOLOGIES)[number]>("Shape Up");
  const [devMode, setDevMode] =
    useState<(typeof DEV_MODES)[number]>("Spec Driven");
  const [addingTitle, setAddingTitle] = useState("");
  const [addingColumn, setAddingColumn] = useState<TaskColumn>("backlog");
  const [addingTag, setAddingTag] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<TaskColumn | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/runtime/state");
    es.addEventListener("state", (ev) => {
      try {
        const next = JSON.parse((ev as MessageEvent).data) as RuntimeState;
        setState(next);
        // Reflect persisted harness picks back into the selectors so
        // the dropdowns stay coherent across reloads / multi-tab use.
        const m = next.harness?.methodology;
        if (m && (METHODOLOGIES as readonly string[]).includes(m)) {
          setMethodology(m as (typeof METHODOLOGIES)[number]);
        }
        const d = next.harness?.devMode;
        if (d && (DEV_MODES as readonly string[]).includes(d)) {
          setDevMode(d as (typeof DEV_MODES)[number]);
        }
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, []);

  /**
   * Persist a methodology / dev-mode change to the harness so the
   * planner system prompt actually picks it up. Failures surface as
   * the inline error banner — best-effort, the local state still
   * updates so the dropdown reflects the user's intent.
   */
  const patchHarness = async (patch: {
    methodology?: string;
    devMode?: string;
  }): Promise<void> => {
    try {
      const res = await fetch("/api/runtime/harness", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`harness patch failed (${res.status})`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onMethodologyChange = (v: (typeof METHODOLOGIES)[number]) => {
    setMethodology(v);
    void patchHarness({ methodology: v });
  };

  const onDevModeChange = (v: (typeof DEV_MODES)[number]) => {
    setDevMode(v);
    void patchHarness({ devMode: v });
  };

  useEffect(() => {
    if (showAdd) addInputRef.current?.focus();
  }, [showAdd]);

  const tasks = state?.tasks ?? [];
  const autoDriveCurrent = state?.autoDrive.current;

  const moveCard = async (id: string, column: TaskColumn) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/runtime/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, column }),
      });
      if (!res.ok) throw new Error(`move failed (${res.status})`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const renameCard = async (id: string, title: string): Promise<boolean> => {
    const trimmed = title.trim().slice(0, MAX_TASK_TITLE_LENGTH);
    if (!trimmed) return false;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/runtime/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, title: trimmed }),
      });
      if (!res.ok) throw new Error(`rename failed (${res.status})`);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const updateSubtasks = async (
    id: string,
    subtasks: SubTask[],
  ): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/runtime/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, subtasks }),
      });
      if (!res.ok) throw new Error(`subtasks failed (${res.status})`);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const deleteCard = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/runtime/tasks", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addCard = async () => {
    const title = addingTitle.trim();
    if (!title) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/runtime/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          column: addingColumn,
          tag: addingTag.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(`create failed (${res.status})`);
      setAddingTitle("");
      setAddingTag("");
      setShowAdd(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runCard = async (task: Task) => {
    if (autoDriveCurrent) {
      setError("auto-drive already running — stop it first");
      return;
    }
    setRunningTaskId(task.id);
    setError(null);
    try {
      // 1. Move to active sprint while it runs.
      await fetch("/api/runtime/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: task.id, column: "active" }),
      });
      // 2. Start auto-drive with the card title as the goal.
      const res = await fetch("/api/runtime/auto-drive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", goal: task.title, maxSteps: 8 }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `start failed (${res.status})`);
      }
      const { run } = (await res.json()) as { run?: { id?: string } };
      // 3. Record the run id on the card.
      if (run?.id) {
        await fetch("/api/runtime/tasks", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: task.id, runId: run.id }),
        });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunningTaskId(null);
    }
  };

  return (
    <aside className="flex h-full w-full flex-col gap-3 overflow-hidden border-r border-zinc-900 bg-black p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-200">Tasks &amp; Sprints</h2>
        <button
          type="button"
          onClick={() => setShowAdd((v) => !v)}
          className="rounded border border-zinc-800 px-2 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
        >
          {showAdd ? "× cancel" : "+ New"}
        </button>
      </div>

      {showAdd && (
        <div className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-2.5">
          <input
            ref={addInputRef}
            value={addingTitle}
            onChange={(e) => setAddingTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addCard();
              if (e.key === "Escape") setShowAdd(false);
            }}
            placeholder="Card title…"
            className="w-full rounded border border-zinc-800 bg-black px-2 py-1.5 text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none"
          />
          <div className="flex gap-2">
            <select
              value={addingColumn}
              onChange={(e) => setAddingColumn(e.target.value as TaskColumn)}
              className="flex-1 rounded border border-zinc-800 bg-black px-2 py-1 text-xs text-zinc-200"
            >
              {COLUMNS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
            <input
              value={addingTag}
              onChange={(e) => setAddingTag(e.target.value.slice(0, 20))}
              placeholder="tag"
              className="w-20 rounded border border-zinc-800 bg-black px-2 py-1 text-xs text-zinc-200 focus:border-zinc-600 focus:outline-none"
            />
            <button
              type="button"
              disabled={!addingTitle.trim() || busy}
              onClick={addCard}
              className="rounded border border-zinc-800 px-3 py-1 text-xs text-zinc-200 hover:border-zinc-700 disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Selector
          label="Methodology"
          value={methodology}
          options={METHODOLOGIES}
          onChange={onMethodologyChange}
        />
        <Selector
          label="Dev mode"
          value={devMode}
          options={DEV_MODES}
          onChange={onDevModeChange}
        />
      </div>

      {error && (
        <p className="font-mono text-[10px] text-red-400">{error}</p>
      )}

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto pr-1">
        {COLUMNS.map((col) => {
          const items = tasks.filter((c) => c.column === col.id);
          const isDropTarget = dragOverColumn === col.id;
          return (
            <section
              key={col.id}
              className="flex flex-col gap-2"
              onDragOver={(e) => {
                // Required to opt the column into being a drop zone.
                if (!e.dataTransfer.types.includes("application/x-card-id")) {
                  return;
                }
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOverColumn !== col.id) setDragOverColumn(col.id);
              }}
              onDragLeave={(e) => {
                // Only clear when leaving the section itself, not a child.
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  return;
                }
                if (dragOverColumn === col.id) setDragOverColumn(null);
              }}
              onDrop={(e) => {
                const id = e.dataTransfer.getData("application/x-card-id");
                setDragOverColumn(null);
                if (!id) return;
                const current = tasks.find((t) => t.id === id);
                if (!current || current.column === col.id) return;
                e.preventDefault();
                void moveCard(id, col.id);
              }}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  {col.title}
                </span>
                <span className="font-mono text-[10px] text-zinc-600">
                  {items.length}
                </span>
              </div>
              <div
                className={`flex flex-col gap-1.5 rounded-md transition ${
                  isDropTarget ? "bg-zinc-900/60 ring-1 ring-zinc-700" : ""
                }`}
              >
                {items.map((c) => (
                  <TaskCard
                    key={c.id}
                    task={c}
                    currentRunId={autoDriveCurrent?.id}
                    runningThisCard={runningTaskId === c.id}
                    busy={busy}
                    onMove={moveCard}
                    onRename={renameCard}
                    onUpdateSubtasks={updateSubtasks}
                    onDelete={deleteCard}
                    onRun={runCard}
                  />
                ))}
                {items.length === 0 && (
                  <p className="rounded-md border border-dashed border-zinc-900 px-2.5 py-3 text-center text-[11px] text-zinc-600">
                    {isDropTarget ? "Drop here" : "Empty"}
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </aside>
  );
}

interface TaskCardProps {
  task: Task;
  currentRunId?: string;
  runningThisCard: boolean;
  busy: boolean;
  onMove: (id: string, column: TaskColumn) => void;
  onRename: (id: string, title: string) => Promise<boolean>;
  onUpdateSubtasks: (id: string, subtasks: SubTask[]) => Promise<boolean>;
  onDelete: (id: string) => void;
  onRun: (task: Task) => void;
}

function TaskCard({
  task,
  currentRunId,
  runningThisCard,
  busy,
  onMove,
  onRename,
  onUpdateSubtasks,
  onDelete,
  onRun,
}: TaskCardProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [dragging, setDragging] = useState(false);
  const [subDraft, setSubDraft] = useState("");
  const [showAddSub, setShowAddSub] = useState(false);
  const editRef = useRef<HTMLInputElement | null>(null);
  const subInputRef = useRef<HTMLInputElement | null>(null);
  const isRunning = task.runId && task.runId === currentRunId;
  const subtasks = task.subtasks ?? [];
  const doneCount = subtasks.filter((s) => s.done).length;

  // Keep the inline edit buffer in sync with upstream renames /
  // SSE pushes whenever we're not actively editing.
  useEffect(() => {
    if (!editing) setDraft(task.title);
  }, [task.title, editing]);

  useEffect(() => {
    if (editing) {
      editRef.current?.focus();
      editRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (showAddSub) subInputRef.current?.focus();
  }, [showAddSub]);

  const toggleSubtask = (sid: string) => {
    const next = subtasks.map((s) =>
      s.id === sid ? { ...s, done: !s.done } : s,
    );
    void onUpdateSubtasks(task.id, next);
  };

  const deleteSubtask = (sid: string) => {
    void onUpdateSubtasks(
      task.id,
      subtasks.filter((s) => s.id !== sid),
    );
  };

  const addSubtask = async () => {
    const trimmed = subDraft.trim().slice(0, MAX_SUBTASK_TITLE_LENGTH);
    if (!trimmed) return;
    if (subtasks.length >= MAX_SUBTASKS_PER_TASK) return;
    const next: SubTask[] = [
      ...subtasks,
      { id: newSubtaskId(), title: trimmed, done: false },
    ];
    const ok = await onUpdateSubtasks(task.id, next);
    if (ok) {
      setSubDraft("");
      // Leave the input open so the user can quickly add several;
      // Escape / blur collapses it (handled below).
    }
  };

  const commitEdit = async () => {
    const next = draft.trim();
    if (!next || next === task.title) {
      setEditing(false);
      setDraft(task.title);
      return;
    }
    const ok = await onRename(task.id, next);
    if (ok) {
      setEditing(false);
    } else {
      // Keep the editor open so the user can fix / retry.
      setDraft(next);
    }
  };

  return (
    <article
      draggable={!editing}
      onDragStart={(e) => {
        if (editing) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData("application/x-card-id", task.id);
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      className={`rounded-md border border-zinc-900 bg-zinc-950/60 p-2.5 transition hover:border-zinc-800 ${
        dragging ? "opacity-50" : ""
      } ${editing ? "cursor-text" : "cursor-grab active:cursor-grabbing"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] text-zinc-500">{task.id}</span>
            {task.tag && (
              <span className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-zinc-400">
                {task.tag}
              </span>
            )}
            {isRunning && (
              <span className="rounded bg-red-500/20 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-red-300 animate-pulse">
                running
              </span>
            )}
            {subtasks.length > 0 && (
              <span
                title={`${doneCount} of ${subtasks.length} sub-tasks complete`}
                className={`rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${
                  doneCount === subtasks.length
                    ? "bg-emerald-500/20 text-emerald-300"
                    : "bg-zinc-800 text-zinc-400"
                }`}
              >
                ☑ {doneCount}/{subtasks.length}
              </span>
            )}
          </div>
          {editing ? (
            <input
              ref={editRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, MAX_TASK_TITLE_LENGTH))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                  setDraft(task.title);
                }
              }}
              onBlur={() => void commitEdit()}
              disabled={busy}
              className="mt-1 w-full rounded border border-zinc-700 bg-black px-1.5 py-1 text-xs leading-5 text-zinc-100 focus:border-zinc-500 focus:outline-none"
            />
          ) : (
            <p
              onDoubleClick={() => setEditing(true)}
              title="Double-click to edit"
              className="mt-1 text-xs leading-5 text-zinc-200"
            >
              {task.title}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 rounded border border-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-600 hover:border-zinc-800 hover:text-zinc-400"
          title="Card actions"
        >
          ⋯
        </button>
      </div>

      {(subtasks.length > 0 || showAddSub) && (
        <ul
          // Stop drag + pointer events bubbling up so interacting
          // with a checkbox / delete × doesn't start a card drag.
          onPointerDown={(e) => e.stopPropagation()}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          className="mt-2 flex flex-col gap-0.5 border-t border-zinc-900 pt-2"
        >
          {subtasks.map((s) => (
            <li
              key={s.id}
              className="group flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-zinc-900/40"
            >
              <input
                type="checkbox"
                checked={s.done}
                disabled={busy}
                onChange={() => toggleSubtask(s.id)}
                className="h-3 w-3 shrink-0 cursor-pointer accent-emerald-500"
              />
              <span
                className={`flex-1 truncate text-[11px] leading-5 ${
                  s.done ? "text-zinc-600 line-through" : "text-zinc-300"
                }`}
              >
                {s.title}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => deleteSubtask(s.id)}
                title="Remove sub-task"
                className="shrink-0 rounded px-1 text-[10px] text-zinc-700 opacity-0 transition hover:text-red-400 group-hover:opacity-100 disabled:opacity-50"
              >
                ×
              </button>
            </li>
          ))}
          {showAddSub && (
            <li className="mt-1 flex items-center gap-1.5">
              <input
                ref={subInputRef}
                value={subDraft}
                onChange={(e) =>
                  setSubDraft(e.target.value.slice(0, MAX_SUBTASK_TITLE_LENGTH))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addSubtask();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setSubDraft("");
                    setShowAddSub(false);
                  }
                }}
                onBlur={() => {
                  if (!subDraft.trim()) setShowAddSub(false);
                }}
                placeholder="Add sub-task…"
                disabled={busy}
                className="flex-1 rounded border border-zinc-800 bg-black px-1.5 py-0.5 text-[11px] text-zinc-100 focus:border-zinc-600 focus:outline-none"
              />
              <button
                type="button"
                disabled={busy || !subDraft.trim()}
                onClick={addSubtask}
                className="rounded border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-zinc-700 disabled:opacity-50"
              >
                add
              </button>
            </li>
          )}
        </ul>
      )}

      {open && (
        <div className="mt-2 flex flex-wrap gap-1.5 border-t border-zinc-900 pt-2">
          {/* Move to column selector */}
          <select
            value={task.column}
            disabled={busy}
            onChange={(e) => {
              onMove(task.id, e.target.value as TaskColumn);
              setOpen(false);
            }}
            className="rounded border border-zinc-800 bg-black px-1.5 py-0.5 text-[10px] text-zinc-300 focus:outline-none"
          >
            {COLUMNS.map((c) => (
              <option key={c.id} value={c.id}>
                → {c.title}
              </option>
            ))}
          </select>
          {/* Edit title inline */}
          <button
            type="button"
            disabled={busy || editing}
            onClick={() => {
              setEditing(true);
              setOpen(false);
            }}
            className="rounded border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-zinc-700 disabled:opacity-50"
          >
            ✎ edit
          </button>
          {/* Add sub-task */}
          <button
            type="button"
            disabled={busy || subtasks.length >= MAX_SUBTASKS_PER_TASK}
            onClick={() => {
              setShowAddSub(true);
              setOpen(false);
            }}
            title={
              subtasks.length >= MAX_SUBTASKS_PER_TASK
                ? `sub-task limit (${MAX_SUBTASKS_PER_TASK}) reached`
                : "Add a sub-task"
            }
            className="rounded border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-zinc-700 disabled:opacity-50"
          >
            + sub-task
          </button>
          {/* Run with auto-drive */}
          {task.column !== "shipped" && (
            <button
              type="button"
              disabled={busy || runningThisCard || !!currentRunId}
              onClick={() => onRun(task)}
              title={currentRunId ? "auto-drive already running" : "Run with auto-drive"}
              className="rounded border border-emerald-900/60 px-2 py-0.5 text-[10px] text-emerald-400 hover:border-emerald-700 hover:bg-emerald-500/10 disabled:opacity-50"
            >
              {runningThisCard ? "starting…" : "▶ run"}
            </button>
          )}
          {/* Delete */}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onDelete(task.id);
              setOpen(false);
            }}
            className="rounded border border-red-900/60 px-2 py-0.5 text-[10px] text-red-400 hover:border-red-700 hover:bg-red-500/10 disabled:opacity-50"
          >
            delete
          </button>
        </div>
      )}
    </article>
  );
}

interface SelectorProps<T extends string> {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}

function Selector<T extends string>({
  label,
  value,
  options,
  onChange,
}: SelectorProps<T>) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="rounded-md border border-zinc-800 bg-black px-2 py-1.5 text-xs text-zinc-200 transition hover:border-zinc-700 focus:border-zinc-600 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
