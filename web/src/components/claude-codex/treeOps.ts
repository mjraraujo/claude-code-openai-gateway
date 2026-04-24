/**
 * Pure helpers for mutating the in-memory file tree the
 * `WorkspaceView` keeps in React state. Pulled out of the component
 * so the (somewhat fiddly) insert/remove logic can be unit tested
 * without React.
 *
 * The tree mirrors what `/api/fs/tree` returns: an array of
 * `TreeNode` rooted at the workspace root (depth-limited; deeper
 * levels are loaded lazily on expand). All paths use `/` as the
 * separator and have NO leading slash — matching `toRelative()` on
 * the server.
 */

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  children?: TreeNode[];
}

/** True if `parent` is the immediate parent dir of `child` (POSIX semantics). */
function parentOf(child: string): string {
  const idx = child.lastIndexOf("/");
  return idx === -1 ? "" : child.slice(0, idx);
}

function nameOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/** Sort siblings: dirs before files, then case-insensitive name. */
function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Insert a node at `path` into `tree`. Returns a fresh tree (the
 * input is not mutated). If the parent isn't loaded yet (the
 * recursion stopped above this level), the insert is a no-op — the
 * parent will load fresh on next expand and pick up the new entry.
 *
 * Idempotent: inserting an already-present path replaces the
 * existing entry (preserving its `children` if it's a directory we
 * already had).
 */
export function insertNode(tree: TreeNode[], node: TreeNode): TreeNode[] {
  const parent = parentOf(node.path);
  if (parent === "") {
    return mergeAt(tree, node);
  }
  return mapChildren(tree, parent, (children) => mergeAt(children, node));
}

function mergeAt(siblings: TreeNode[], node: TreeNode): TreeNode[] {
  const idx = siblings.findIndex((s) => s.path === node.path);
  if (idx === -1) {
    const next = siblings.concat({ ...node }).sort(compareNodes);
    return next;
  }
  // Replace; keep existing children if the incoming node didn't
  // bring fresh ones. Avoids dropping an expanded subtree just
  // because the watcher fired a "change" on the directory.
  const existing = siblings[idx];
  const merged: TreeNode = {
    ...existing,
    ...node,
    children:
      node.children !== undefined ? node.children : existing.children,
  };
  const next = siblings.slice();
  next[idx] = merged;
  return next;
}

/**
 * Remove a node at `path` from `tree`. Returns a fresh tree. No-op
 * if the path isn't present (e.g. it lived inside a not-yet-loaded
 * subtree).
 */
export function removeNode(tree: TreeNode[], path: string): TreeNode[] {
  if (path === "") return tree;
  const parent = parentOf(path);
  if (parent === "") {
    const next = tree.filter((n) => n.path !== path);
    return next.length === tree.length ? tree : next;
  }
  return mapChildren(tree, parent, (children) => {
    const next = children.filter((c) => c.path !== path);
    return next.length === children.length ? children : next;
  });
}

/**
 * Walk `tree` to the directory at `parentPath` and replace its
 * children with `update(prev)`. If the directory isn't found in the
 * loaded tree (e.g. it lives below the depth-limit), returns the
 * tree unchanged.
 */
function mapChildren(
  tree: TreeNode[],
  parentPath: string,
  update: (prev: TreeNode[]) => TreeNode[],
): TreeNode[] {
  let changed = false;
  const recur = (nodes: TreeNode[], prefix: string): TreeNode[] => {
    let mut: TreeNode[] | null = null;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type !== "dir") continue;
      if (n.path === parentPath) {
        const prev = n.children ?? [];
        const nextChildren = update(prev);
        if (nextChildren !== prev) {
          if (!mut) mut = nodes.slice();
          mut[i] = { ...n, children: nextChildren };
          changed = true;
        }
      } else if (
        n.children &&
        (parentPath === n.path ||
          parentPath.startsWith(n.path + "/") ||
          (prefix === "" && parentPath.startsWith(n.path)))
      ) {
        const recursed = recur(n.children, n.path);
        if (recursed !== n.children) {
          if (!mut) mut = nodes.slice();
          mut[i] = { ...n, children: recursed };
        }
      }
    }
    return mut ?? nodes;
  };
  const out = recur(tree, "");
  return changed ? out : tree;
}

/**
 * Compute the set of parent directories that need to be expanded so
 * the node at `path` is visible. Used after an `add` event to
 * auto-reveal new files. Pure helper.
 */
export function parentsToExpand(path: string): string[] {
  if (path === "") return [];
  const parts = path.split("/");
  const out: string[] = [""]; // root is always "expanded"
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc === "" ? parts[i] : `${acc}/${parts[i]}`;
    out.push(acc);
  }
  return out;
}

/**
 * Build a `TreeNode` from a workspace-relative path + type. The
 * `name` is just the last path segment — convenience so callers
 * don't have to recompute it.
 */
export function nodeFor(p: string, type: "file" | "dir"): TreeNode {
  return { name: nameOf(p), path: p, type };
}
