"use client";

/**
 * Minimal SprintPanel — lists existing sprints from runtime state
 * and shows which tasks are attached to each. The dashboard
 * doesn't yet have a UI for creating sprints (that's a future PR);
 * this view is read-only for now and exists so the standalone
 * `/sprints` route has something to render.
 */

import { useRuntimeState } from "@/lib/runtime/client";

export function SprintPanel() {
  const state = useRuntimeState();

  if (!state) {
    return (
      <section className="flex h-full items-center justify-center bg-black text-zinc-500">
        loading…
      </section>
    );
  }

  const sprints = state.sprints ?? [];
  return (
    <section className="flex h-full flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-900 px-4 py-2">
        <span className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          sprints
        </span>
        <span className="font-mono text-[10px] text-zinc-500">
          {sprints.length} sprint{sprints.length === 1 ? "" : "s"}
        </span>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {sprints.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No sprints yet. Sprints are attached to tasks via{" "}
            <code className="font-mono text-zinc-400">sprintId</code>.
          </p>
        ) : (
          <ul className="space-y-3">
            {sprints.map((s) => {
              const tasks = state.tasks.filter((t) => t.sprintId === s.id);
              return (
                <li
                  key={s.id}
                  className="rounded border border-zinc-800 bg-zinc-900/40 p-3"
                >
                  <div className="flex items-baseline justify-between">
                    <h3 className="text-sm font-semibold text-zinc-100">
                      {s.name}
                    </h3>
                    <span className="font-mono text-[10px] text-zinc-500">
                      {s.startsAt ?? ""}
                      {s.startsAt && s.endsAt ? " → " : ""}
                      {s.endsAt ?? ""}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-zinc-600">
                    {tasks.length} task{tasks.length === 1 ? "" : "s"}
                  </p>
                  {tasks.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {tasks.map((t) => (
                        <li
                          key={t.id}
                          className="rounded bg-zinc-900/60 px-2 py-1 text-xs text-zinc-300"
                        >
                          {t.title}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
