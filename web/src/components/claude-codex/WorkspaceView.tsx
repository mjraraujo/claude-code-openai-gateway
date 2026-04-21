"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";

// Monaco brings ~3-4 MB of JS — load it only when the Workspace tab
// is mounted, and never on the server (it touches `window`).
const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-xs text-zinc-500">
        Loading editor…
      </div>
    ),
  },
);

interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  children?: TreeNode[];
}

interface FileResponse {
  path: string;
  content: string;
  language: string;
  size: number;
}

type SaveState = "clean" | "dirty" | "saving" | "saved" | "error";

export function WorkspaceView() {
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [file, setFile] = useState<FileResponse | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [saveState, setSaveState] = useState<SaveState>("clean");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/fs/tree", { cache: "no-store" });
        if (!res.ok) throw new Error(`tree failed (${res.status})`);
        const data = (await res.json()) as { tree: TreeNode[] };
        if (!cancelled) setTree(data.tree);
      } catch (err) {
        if (!cancelled)
          setTreeError(err instanceof Error ? err.message : "tree failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openFile = useCallback(async (p: string) => {
    setOpenPath(p);
    setSaveState("clean");
    setSaveError(null);
    setFile(null);
    try {
      const res = await fetch(
        `/api/fs/file?path=${encodeURIComponent(p)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error || `read failed (${res.status})`);
      }
      const data = (await res.json()) as FileResponse;
      setFile(data);
      setDraft(data.content);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "read failed");
      setSaveState("error");
    }
  }, []);

  const onChange = useCallback(
    (value: string | undefined) => {
      const next = value ?? "";
      setDraft(next);
      setSaveState(file && next !== file.content ? "dirty" : "clean");
    },
    [file],
  );

  const save = useCallback(async () => {
    if (!file || saveState === "saving") return;
    setSaveState("saving");
    setSaveError(null);
    try {
      const res = await fetch("/api/fs/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: file.path, content: draft }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error || `save failed (${res.status})`);
      }
      setFile({ ...file, content: draft });
      setSaveState("saved");
      setTimeout(
        () => setSaveState((s) => (s === "saved" ? "clean" : s)),
        1500,
      );
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "save failed");
      setSaveState("error");
    }
  }, [draft, file, saveState]);

  // Cmd/Ctrl-S to save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (saveState === "dirty") void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, saveState]);

  const toggle = useCallback((p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  const statusLabel = useMemo(() => {
    switch (saveState) {
      case "saving":
        return "saving…";
      case "saved":
        return "saved";
      case "dirty":
        return "modified · ⌘S";
      case "error":
        return saveError ?? "error";
      default:
        return "ready";
    }
  }, [saveError, saveState]);

  return (
    <div className="flex h-full">
      <div className="w-64 shrink-0 overflow-y-auto border-r border-zinc-900 bg-black p-2 text-xs">
        <div className="mb-2 flex items-center justify-between px-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            Explorer
          </p>
        </div>
        {tree && (
          <FileTree
            nodes={tree}
            expanded={expanded}
            openPath={openPath}
            onToggle={toggle}
            onOpen={openFile}
          />
        )}
        {!tree && !treeError && (
          <p className="px-2 py-3 text-zinc-500">Loading…</p>
        )}
        {treeError && (
          <p className="px-2 py-3 text-red-400">{treeError}</p>
        )}
      </div>

      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-zinc-900 bg-zinc-950 px-3 py-1.5">
          <span className="font-mono text-[11px] text-zinc-300">
            {openPath ?? "no file open"}
          </span>
          <div className="flex items-center gap-3">
            <span
              className={
                "font-mono text-[10px] " +
                (saveState === "error"
                  ? "text-red-400"
                  : saveState === "dirty"
                    ? "text-amber-400"
                    : saveState === "saved"
                      ? "text-emerald-400"
                      : "text-zinc-500")
              }
            >
              {statusLabel}
            </span>
            <button
              type="button"
              onClick={save}
              disabled={saveState !== "dirty"}
              className="rounded border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>

        <div className="flex-1">
          {file ? (
            <MonacoEditor
              height="100%"
              theme="vs-dark"
              language={file.language}
              value={draft}
              onChange={onChange}
              options={{
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: 12,
                minimap: { enabled: false },
                smoothScrolling: true,
                scrollBeyondLastLine: false,
                tabSize: 2,
                automaticLayout: true,
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-zinc-600">
              {openPath ? "Loading file…" : "Pick a file from the explorer."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface FileTreeProps {
  nodes: TreeNode[];
  expanded: Set<string>;
  openPath: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  depth?: number;
}

function FileTree({
  nodes,
  expanded,
  openPath,
  onToggle,
  onOpen,
  depth = 0,
}: FileTreeProps) {
  return (
    <ul className="select-none">
      {nodes.map((n) => {
        const isExpanded = expanded.has(n.path);
        const active = openPath === n.path;
        return (
          <li key={n.path}>
            <button
              type="button"
              onClick={() => (n.type === "dir" ? onToggle(n.path) : onOpen(n.path))}
              className={
                "flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left transition " +
                (active
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-300 hover:bg-zinc-900")
              }
              style={{ paddingLeft: 4 + depth * 10 }}
              title={n.path}
            >
              <span className="font-mono text-[10px] text-zinc-600">
                {n.type === "dir" ? (isExpanded ? "▾" : "▸") : " "}
              </span>
              <span className="truncate">{n.name}</span>
            </button>
            {n.type === "dir" && isExpanded && n.children && (
              <FileTree
                nodes={n.children}
                expanded={expanded}
                openPath={openPath}
                onToggle={onToggle}
                onOpen={onOpen}
                depth={depth + 1}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
