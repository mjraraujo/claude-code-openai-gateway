"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  loadPersisted,
  resolveRestore,
  savePersisted,
  type PersistedEditorState,
  type PersistedSnapshot,
} from "./editorPersistence";
import {
  insertNode,
  nodeFor,
  parentsToExpand,
  removeNode,
  type TreeNode,
} from "./treeOps";

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

interface FileResponse {
  path: string;
  content: string;
  language: string;
  size: number;
  mtimeMs: number;
}

type SaveState = "clean" | "dirty" | "saving" | "saved" | "error";

interface FsEvent {
  type: "add" | "change" | "unlink" | "addDir" | "unlinkDir";
  path: string;
}

interface ConflictPrompt {
  diskContent: string;
  diskSnapshot: PersistedSnapshot;
  draft: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  /** "" means the workspace root (used by the Explorer toolbar). */
  targetPath: string;
  targetType: "dir" | "file";
}

export function WorkspaceView() {
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string>("");
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [file, setFile] = useState<FileResponse | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [saveState, setSaveState] = useState<SaveState>("clean");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [externallyModified, setExternallyModified] = useState(false);
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  // Refs so SSE handlers (long-lived listener) and event callbacks
  // see the latest state without re-subscribing on every render.
  const openPathRef = useRef<string | null>(null);
  const draftRef = useRef<string>("");
  const fileRef = useRef<FileResponse | null>(null);
  const saveStateRef = useRef<SaveState>("clean");
  // Timestamp (ms) of the most recent successful save. The watcher
  // will emit a `change` event for our own write a beat later — we
  // ignore change events that arrive within this window so the
  // editor doesn't immediately scream "modified externally" at the
  // operator's own keystrokes. Sized at ~5x the watcher's 150ms
  // debounce so a slow event loop still catches our own write,
  // but well under any plausible human "open another tool, edit,
  // save" loop.
  const lastSelfWriteRef = useRef<number>(0);

  useEffect(() => {
    openPathRef.current = openPath;
  }, [openPath]);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    fileRef.current = file;
  }, [file]);
  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);

  // ---- Initial tree load -------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/fs/tree", { cache: "no-store" });
        if (!res.ok) throw new Error(`tree failed (${res.status})`);
        const data = (await res.json()) as { tree: TreeNode[]; root: string };
        if (!cancelled) {
          setTree(data.tree);
          setWorkspaceRoot(data.root || "/");
        }
      } catch (err) {
        if (!cancelled)
          setTreeError(err instanceof Error ? err.message : "tree failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- File open helper (used by tree click + restore + reload) ----------
  const openFile = useCallback(
    async (
      p: string,
      opts: { restoreDraft?: PersistedEditorState } = {},
    ) => {
      setOpenPath(p);
      setSaveState("clean");
      setSaveError(null);
      setExternallyModified(false);
      setFile(null);
      setConflict(null);
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

        if (opts.restoreDraft) {
          const decision = resolveRestore(
            opts.restoreDraft,
            data.content,
            { size: data.size, mtimeMs: data.mtimeMs },
          );
          if (decision === "no_draft" || decision === "fast_path") {
            setDraft(data.content);
            setSaveState("clean");
          } else if (decision === "unchanged") {
            setDraft(opts.restoreDraft.draft ?? data.content);
            setSaveState("dirty");
          } else {
            // conflict — show the picker, keep draft pristine for now
            setDraft(data.content);
            setSaveState("clean");
            setConflict({
              diskContent: data.content,
              diskSnapshot: { size: data.size, mtimeMs: data.mtimeMs },
              draft: opts.restoreDraft.draft ?? "",
            });
          }
        } else {
          setDraft(data.content);
        }
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "read failed");
        setSaveState("error");
      }
    },
    [],
  );

  // ---- Restore session from localStorage --------------------------------
  // Runs once we know the workspace root (so the storage key is stable).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !workspaceRoot) return;
    restoredRef.current = true;
    const persisted = loadPersisted(workspaceRoot);
    if (persisted) {
      // Reveal the file's parents in the explorer too.
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const p of parentsToExpand(persisted.openPath)) next.add(p);
        return next;
      });
      void openFile(persisted.openPath, { restoreDraft: persisted });
    }
  }, [workspaceRoot, openFile]);

  // ---- Persist openPath / draft on change -------------------------------
  useEffect(() => {
    if (!workspaceRoot) return;
    if (!openPath) {
      savePersisted(workspaceRoot, null);
      return;
    }
    const isDirty = saveState === "dirty";
    const state: PersistedEditorState = {
      openPath,
      draft: isDirty ? draft : undefined,
      baseline:
        isDirty && file
          ? { size: file.size, mtimeMs: file.mtimeMs }
          : undefined,
    };
    savePersisted(workspaceRoot, state);
  }, [workspaceRoot, openPath, draft, saveState, file]);

  // ---- SSE: real-time tree + externally-modified detection --------------
  useEffect(() => {
    if (!tree) return; // wait for the first tree fetch
    const ctrl = new AbortController();
    let buffer = "";

    const applyEvent = (ev: FsEvent) => {
      // Tree mutation. mapChildren is a no-op for paths beneath the
      // depth limit, so this is safe even for events on subtrees we
      // never loaded.
      if (ev.type === "add") {
        setTree((t) => (t ? insertNode(t, nodeFor(ev.path, "file")) : t));
        setExpanded((prev) => {
          const next = new Set(prev);
          for (const p of parentsToExpand(ev.path)) next.add(p);
          return next;
        });
      } else if (ev.type === "addDir") {
        setTree((t) => (t ? insertNode(t, nodeFor(ev.path, "dir")) : t));
      } else if (ev.type === "unlink" || ev.type === "unlinkDir") {
        setTree((t) => (t ? removeNode(t, ev.path) : t));
        // If the unlinked file was the open one, drop the editor.
        if (openPathRef.current === ev.path) {
          setOpenPath(null);
          setFile(null);
          setDraft("");
          setSaveState("clean");
        }
      } else if (ev.type === "change") {
        // Only flag "externally modified" if (a) it's our open file,
        // (b) we're not mid-save, and (c) the watcher tick wasn't
        // generated by our own write (which echoes back ~150ms after
        // the PUT completes).
        if (
          openPathRef.current === ev.path &&
          saveStateRef.current !== "saving" &&
          Date.now() - lastSelfWriteRef.current > 750
        ) {
          setExternallyModified(true);
        }
      }
    };

    (async () => {
      let res: Response;
      try {
        res = await fetch("/api/fs/events", { signal: ctrl.signal });
      } catch {
        return;
      }
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const event = parseSseBlock(block);
            if (event && event.type === "fs") {
              const data = event.data as FsEvent | undefined;
              if (data && typeof data.path === "string") {
                applyEvent(data);
              }
            }
          }
        }
      } catch {
        /* aborted or network blip — caller will reconnect on remount */
      }
    })();

    return () => ctrl.abort();
  }, [tree]);

  // ---- Editor onChange / save -------------------------------------------
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
      const data = (await res.json()) as { size: number; mtimeMs: number };
      setFile({ ...file, content: draft, size: data.size, mtimeMs: data.mtimeMs });
      setSaveState("saved");
      setExternallyModified(false);
      lastSelfWriteRef.current = Date.now();
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

  // ---- Mutations: new file, new folder, rename, delete -------------------
  const promptCreateFile = useCallback(
    async (parentPath: string) => {
      const name = window.prompt("New file name");
      if (!name) return;
      const cleaned = name.trim();
      if (!cleaned) return;
      const target =
        parentPath === "" ? cleaned : `${parentPath}/${cleaned}`;
      try {
        const res = await fetch("/api/fs/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: target, content: "" }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error || `create failed (${res.status})`);
        }
      } catch (err) {
        window.alert(
          `Could not create file: ${err instanceof Error ? err.message : "error"}`,
        );
      }
    },
    [],
  );

  const promptCreateDir = useCallback(async (parentPath: string) => {
    const name = window.prompt("New folder name");
    if (!name) return;
    const cleaned = name.trim();
    if (!cleaned) return;
    const target = parentPath === "" ? cleaned : `${parentPath}/${cleaned}`;
    try {
      const res = await fetch("/api/fs/dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error || `mkdir failed (${res.status})`);
      }
    } catch (err) {
      window.alert(
        `Could not create folder: ${err instanceof Error ? err.message : "error"}`,
      );
    }
  }, []);

  const promptRename = useCallback(async (target: string) => {
    if (!target) return;
    const last = target.lastIndexOf("/");
    const parent = last === -1 ? "" : target.slice(0, last);
    const oldName = last === -1 ? target : target.slice(last + 1);
    const next = window.prompt("Rename to", oldName);
    if (!next) return;
    const cleaned = next.trim();
    if (!cleaned || cleaned === oldName) return;
    const dest = parent === "" ? cleaned : `${parent}/${cleaned}`;
    try {
      const res = await fetch("/api/fs/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: target, to: dest }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error || `rename failed (${res.status})`);
      }
      // If we renamed the open file, follow it.
      if (openPathRef.current === target) {
        await openFile(dest);
      }
    } catch (err) {
      window.alert(
        `Could not rename: ${err instanceof Error ? err.message : "error"}`,
      );
    }
  }, [openFile]);

  const promptDelete = useCallback(
    async (target: string, kind: "file" | "dir") => {
      if (!target) return;
      const ok = window.confirm(`Delete ${kind} "${target}"?`);
      if (!ok) return;
      const url = kind === "file" ? "/api/fs/file" : "/api/fs/dir";
      try {
        const res = await fetch(url, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: target,
            ...(kind === "dir" ? { recursive: false } : {}),
          }),
        });
        if (res.status === 409 && kind === "dir") {
          const force = window.confirm(
            `"${target}" is not empty. Delete it and everything inside?`,
          );
          if (!force) return;
          const res2 = await fetch("/api/fs/dir", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: target, recursive: true }),
          });
          if (!res2.ok) {
            const body = (await res2.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(body.error || `delete failed (${res2.status})`);
          }
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error || `delete failed (${res.status})`);
        }
      } catch (err) {
        window.alert(
          `Could not delete: ${err instanceof Error ? err.message : "error"}`,
        );
      }
    },
    [],
  );

  // ---- Externally-modified reload helper --------------------------------
  const reloadFromDisk = useCallback(async () => {
    if (!openPath) return;
    await openFile(openPath);
  }, [openPath, openFile]);

  // Resolve the conflict prompt's three buttons.
  const acceptDisk = useCallback(() => {
    if (!conflict || !file) return;
    setDraft(conflict.diskContent);
    setSaveState("clean");
    setConflict(null);
  }, [conflict, file]);
  const keepDraft = useCallback(() => {
    if (!conflict) return;
    setDraft(conflict.draft);
    setSaveState("dirty");
    setConflict(null);
  }, [conflict]);

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

  // Close any open context menu when clicking elsewhere.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  return (
    <div className="flex h-full">
      <div className="w-64 shrink-0 overflow-y-auto border-r border-zinc-900 bg-black p-2 text-xs">
        <div className="mb-2 flex items-center justify-between gap-1 px-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            Explorer
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              title="New file in workspace root"
              onClick={() => promptCreateFile("")}
              className="rounded px-1 text-[11px] text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
              aria-label="New file"
            >
              +F
            </button>
            <button
              type="button"
              title="New folder in workspace root"
              onClick={() => promptCreateDir("")}
              className="rounded px-1 text-[11px] text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
              aria-label="New folder"
            >
              +D
            </button>
          </div>
        </div>
        {tree && (
          <FileTree
            nodes={tree}
            expanded={expanded}
            openPath={openPath}
            onToggle={toggle}
            onOpen={(p) => void openFile(p)}
            onContextMenu={(e, node) => {
              e.preventDefault();
              setMenu({
                x: e.clientX,
                y: e.clientY,
                targetPath: node.path,
                targetType: node.type,
              });
            }}
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
            {externallyModified && (
              <button
                type="button"
                onClick={() => void reloadFromDisk()}
                title="The file was changed on disk by another process. Click to reload."
                className="rounded border border-amber-700/60 bg-amber-900/20 px-2 py-0.5 font-mono text-[10px] text-amber-300 hover:bg-amber-900/40"
              >
                modified externally · reload
              </button>
            )}
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

        <div className="relative flex-1">
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

          {conflict && (
            <div className="absolute inset-x-4 top-4 z-10 rounded-md border border-amber-700/60 bg-zinc-900 p-3 shadow-lg">
              <p className="text-xs font-medium text-amber-300">
                Unsaved changes vs. on-disk version
              </p>
              <p className="mt-1 text-[11px] text-zinc-400">
                The file changed on disk while you had unsaved edits.
                Choose which copy to keep — neither has been overwritten yet.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={acceptDisk}
                  className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:border-zinc-500"
                >
                  Use disk version (discard mine)
                </button>
                <button
                  type="button"
                  onClick={keepDraft}
                  className="rounded border border-amber-700 px-2 py-0.5 text-[11px] text-amber-200 hover:border-amber-500"
                >
                  Keep my changes (overwrite on save)
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {menu && (
        <ContextMenu
          state={menu}
          onClose={() => setMenu(null)}
          onNewFile={() =>
            promptCreateFile(
              menu.targetType === "dir" ? menu.targetPath : parentOf(menu.targetPath),
            )
          }
          onNewDir={() =>
            promptCreateDir(
              menu.targetType === "dir" ? menu.targetPath : parentOf(menu.targetPath),
            )
          }
          onRename={() => promptRename(menu.targetPath)}
          onDelete={() => promptDelete(menu.targetPath, menu.targetType)}
        />
      )}
    </div>
  );
}

function parentOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}

interface ContextMenuProps {
  state: ContextMenuState;
  onClose: () => void;
  onNewFile: () => void;
  onNewDir: () => void;
  onRename: () => void;
  onDelete: () => void;
}

function ContextMenu({
  state,
  onClose,
  onNewFile,
  onNewDir,
  onRename,
  onDelete,
}: ContextMenuProps) {
  return (
    <div
      role="menu"
      style={{ left: state.x, top: state.y }}
      className="fixed z-50 min-w-[160px] rounded-md border border-zinc-700 bg-zinc-900 py-1 text-[11px] text-zinc-200 shadow-xl"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onNewFile();
          onClose();
        }}
        className="block w-full px-3 py-1 text-left hover:bg-zinc-800"
      >
        New file…
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onNewDir();
          onClose();
        }}
        className="block w-full px-3 py-1 text-left hover:bg-zinc-800"
      >
        New folder…
      </button>
      <div className="my-1 border-t border-zinc-800" />
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onRename();
          onClose();
        }}
        className="block w-full px-3 py-1 text-left hover:bg-zinc-800"
      >
        Rename…
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onDelete();
          onClose();
        }}
        className="block w-full px-3 py-1 text-left text-red-300 hover:bg-zinc-800"
      >
        Delete
      </button>
    </div>
  );
}

interface FileTreeProps {
  nodes: TreeNode[];
  expanded: Set<string>;
  openPath: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  depth?: number;
}

function FileTree({
  nodes,
  expanded,
  openPath,
  onToggle,
  onOpen,
  onContextMenu,
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
              onClick={() =>
                n.type === "dir" ? onToggle(n.path) : onOpen(n.path)
              }
              onContextMenu={(e) => onContextMenu(e, n)}
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
                onContextMenu={onContextMenu}
                depth={depth + 1}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Parse a single SSE block ("event: foo\ndata: ...") into a tagged
 * union the caller can switch on. Returns null if neither field
 * shows up. Pure helper kept inside the component module because
 * nothing else needs it.
 */
function parseSseBlock(
  block: string,
): { type: string; data: unknown } | null {
  let event = "message";
  let dataStr = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
  }
  if (!dataStr) return { type: event, data: null };
  try {
    return { type: event, data: JSON.parse(dataStr) as unknown };
  } catch {
    return null;
  }
}
