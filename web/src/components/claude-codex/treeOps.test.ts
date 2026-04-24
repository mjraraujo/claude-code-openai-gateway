import { describe, expect, it } from "vitest";

import {
  insertNode,
  nodeFor,
  parentsToExpand,
  removeNode,
  type TreeNode,
} from "./treeOps";

function tree(): TreeNode[] {
  return [
    {
      name: "src",
      path: "src",
      type: "dir",
      children: [
        { name: "index.ts", path: "src/index.ts", type: "file" },
        {
          name: "lib",
          path: "src/lib",
          type: "dir",
          children: [{ name: "a.ts", path: "src/lib/a.ts", type: "file" }],
        },
      ],
    },
    { name: "README.md", path: "README.md", type: "file" },
  ];
}

describe("insertNode", () => {
  it("adds a new file at the root, sorted dirs-before-files then by name", () => {
    const next = insertNode(tree(), nodeFor("LICENSE", "file"));
    expect(next.map((n) => n.path)).toEqual(["src", "LICENSE", "README.md"]);
  });

  it("adds a new file inside a known subdirectory", () => {
    const next = insertNode(tree(), nodeFor("src/lib/b.ts", "file"));
    const lib = (next[0].children ?? []).find((c) => c.path === "src/lib");
    expect(lib?.children?.map((c) => c.path)).toEqual([
      "src/lib/a.ts",
      "src/lib/b.ts",
    ]);
  });

  it("adds a new directory and slots it before sibling files", () => {
    const next = insertNode(tree(), nodeFor("src/utils", "dir"));
    const srcChildren = next[0].children ?? [];
    expect(srcChildren.map((c) => c.path)).toEqual([
      "src/lib",
      "src/utils",
      "src/index.ts",
    ]);
  });

  it("is a no-op when the parent isn't loaded (deeper than the depth limit)", () => {
    const t = tree();
    const next = insertNode(t, nodeFor("src/lib/deep/x.ts", "file"));
    // src/lib/deep doesn't exist as a known node; nothing to insert
    // into. Returns the input unchanged so React state stays stable.
    expect(next).toBe(t);
  });

  it("replaces an existing entry but preserves its loaded children", () => {
    const t = tree();
    const replacement: TreeNode = { name: "lib", path: "src/lib", type: "dir" };
    const next = insertNode(t, replacement);
    const lib = next[0].children?.find((c) => c.path === "src/lib");
    // Existing `children` survived even though the replacement
    // didn't carry any.
    expect(lib?.children?.map((c) => c.path)).toEqual(["src/lib/a.ts"]);
  });
});

describe("removeNode", () => {
  it("removes a file at the root", () => {
    const next = removeNode(tree(), "README.md");
    expect(next.map((n) => n.path)).toEqual(["src"]);
  });

  it("removes a nested file", () => {
    const next = removeNode(tree(), "src/lib/a.ts");
    const lib = next[0].children?.find((c) => c.path === "src/lib");
    expect(lib?.children).toEqual([]);
  });

  it("is a no-op when the path isn't in the loaded tree", () => {
    const t = tree();
    expect(removeNode(t, "ghost")).toBe(t);
    expect(removeNode(t, "src/ghost.ts")).toBe(t);
  });

  it("refuses to remove the root", () => {
    const t = tree();
    expect(removeNode(t, "")).toBe(t);
  });
});

describe("parentsToExpand", () => {
  it("returns just the root for a top-level entry", () => {
    expect(parentsToExpand("README.md")).toEqual([""]);
  });

  it("returns every ancestor for a deeply nested entry", () => {
    expect(parentsToExpand("a/b/c/d.ts")).toEqual(["", "a", "a/b", "a/b/c"]);
  });
});
