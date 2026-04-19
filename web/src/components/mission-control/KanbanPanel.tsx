"use client";

import { useState } from "react";

const COLUMNS = [
  { id: "backlog", title: "Backlog" },
  { id: "active", title: "Active Sprint" },
  { id: "review", title: "In Review" },
  { id: "shipped", title: "Shipped" },
] as const;

interface Card {
  id: string;
  title: string;
  column: (typeof COLUMNS)[number]["id"];
  tag?: string;
}

const SEED_CARDS: Card[] = [
  { id: "T-101", title: "Wire OAuth device flow to gateway", column: "shipped", tag: "auth" },
  { id: "T-102", title: "Mission Control 3-panel shell", column: "active", tag: "ui" },
  { id: "T-103", title: "Embed Monaco workspace tab", column: "active", tag: "editor" },
  { id: "T-104", title: "Real PTY for in-browser terminal", column: "review", tag: "infra" },
  { id: "T-105", title: "Departments + cron matrix", column: "backlog", tag: "ops" },
  { id: "T-106", title: "Full Auto Drive safety rails", column: "backlog", tag: "safety" },
];

const METHODOLOGIES = ["Shape Up", "Scrum", "Kanban", "Spec-First"] as const;
const DEV_MODES = ["Vibe Code", "Spec Driven"] as const;

export function KanbanPanel() {
  const [cards] = useState<Card[]>(SEED_CARDS);
  const [methodology, setMethodology] =
    useState<(typeof METHODOLOGIES)[number]>("Shape Up");
  const [devMode, setDevMode] =
    useState<(typeof DEV_MODES)[number]>("Spec Driven");

  return (
    <aside className="flex h-full w-full flex-col gap-4 overflow-hidden border-r border-zinc-900 bg-black p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-200">Tasks &amp; Sprints</h2>
        <button
          type="button"
          className="rounded border border-zinc-800 px-2 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
        >
          + New
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Selector
          label="Methodology"
          value={methodology}
          options={METHODOLOGIES}
          onChange={setMethodology}
        />
        <Selector
          label="Dev mode"
          value={devMode}
          options={DEV_MODES}
          onChange={setDevMode}
        />
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto pr-1">
        {COLUMNS.map((col) => {
          const items = cards.filter((c) => c.column === col.id);
          return (
            <section key={col.id} className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  {col.title}
                </span>
                <span className="font-mono text-[10px] text-zinc-600">
                  {items.length}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {items.map((c) => (
                  <article
                    key={c.id}
                    className="rounded-md border border-zinc-900 bg-zinc-950/60 p-2.5 transition hover:border-zinc-800"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] text-zinc-500">
                        {c.id}
                      </span>
                      {c.tag && (
                        <span className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-zinc-400">
                          {c.tag}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-zinc-200">
                      {c.title}
                    </p>
                  </article>
                ))}
                {items.length === 0 && (
                  <p className="rounded-md border border-dashed border-zinc-900 px-2.5 py-3 text-center text-[11px] text-zinc-600">
                    Empty
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
