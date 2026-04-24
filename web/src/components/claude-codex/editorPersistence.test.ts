import { describe, expect, it } from "vitest";

import {
  parsePersisted,
  resolveRestore,
  type PersistedEditorState,
} from "./editorPersistence";

describe("parsePersisted", () => {
  it("returns null for null / empty / non-JSON", () => {
    expect(parsePersisted(null)).toBeNull();
    expect(parsePersisted("")).toBeNull();
    expect(parsePersisted("not json")).toBeNull();
  });

  it("returns null when openPath is missing or not a string", () => {
    expect(parsePersisted("{}")).toBeNull();
    expect(parsePersisted(JSON.stringify({ openPath: 5 }))).toBeNull();
    expect(parsePersisted(JSON.stringify({ openPath: "" }))).toBeNull();
  });

  it("parses a minimal valid blob", () => {
    expect(parsePersisted(JSON.stringify({ openPath: "src/a.ts" }))).toEqual({
      openPath: "src/a.ts",
    });
  });

  it("parses draft and baseline when present", () => {
    const raw = JSON.stringify({
      openPath: "a.txt",
      draft: "hi",
      baseline: { size: 10, mtimeMs: 999 },
    });
    expect(parsePersisted(raw)).toEqual({
      openPath: "a.txt",
      draft: "hi",
      baseline: { size: 10, mtimeMs: 999 },
    });
  });

  it("drops a malformed baseline but keeps the rest", () => {
    const raw = JSON.stringify({
      openPath: "a.txt",
      draft: "hi",
      baseline: { size: "ten", mtimeMs: 999 },
    });
    expect(parsePersisted(raw)).toEqual({ openPath: "a.txt", draft: "hi" });
  });
});

describe("resolveRestore", () => {
  const disk = "console.log('disk');\n";
  const snap = { size: disk.length, mtimeMs: 1234 };

  it("no_draft when there's no unsaved buffer", () => {
    const s: PersistedEditorState = { openPath: "a.ts" };
    expect(resolveRestore(s, disk, snap)).toBe("no_draft");
  });

  it("fast_path when the persisted draft equals what's on disk", () => {
    const s: PersistedEditorState = { openPath: "a.ts", draft: disk };
    expect(resolveRestore(s, disk, snap)).toBe("fast_path");
  });

  it("unchanged when the baseline still matches disk (safe to restore)", () => {
    const s: PersistedEditorState = {
      openPath: "a.ts",
      draft: "modified",
      baseline: { ...snap },
    };
    expect(resolveRestore(s, disk, snap)).toBe("unchanged");
  });

  it("conflict when disk changed since the draft was authored", () => {
    const s: PersistedEditorState = {
      openPath: "a.ts",
      draft: "modified",
      baseline: { size: snap.size + 5, mtimeMs: snap.mtimeMs },
    };
    expect(resolveRestore(s, disk, snap)).toBe("conflict");
  });

  it("conflict when the baseline is missing entirely (we can't prove safety)", () => {
    const s: PersistedEditorState = { openPath: "a.ts", draft: "x" };
    expect(resolveRestore(s, disk, snap)).toBe("conflict");
  });
});
