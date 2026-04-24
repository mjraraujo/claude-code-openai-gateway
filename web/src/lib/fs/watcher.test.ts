import { describe, expect, it, vi } from "vitest";

import {
  classifyFsEvent,
  makeDebouncer,
  type FsEvent,
} from "./watcher";

describe("classifyFsEvent", () => {
  it("emits add for a brand-new file", () => {
    expect(classifyFsEvent("a.txt", "file", null)).toEqual<FsEvent>({
      type: "add",
      path: "a.txt",
    });
  });

  it("emits change when an existing file is modified", () => {
    expect(classifyFsEvent("a.txt", "file", false)).toEqual<FsEvent>({
      type: "change",
      path: "a.txt",
    });
  });

  it("emits addDir for a brand-new directory", () => {
    expect(classifyFsEvent("src", "dir", null)).toEqual<FsEvent>({
      type: "addDir",
      path: "src",
    });
  });

  it("does NOT re-emit addDir for a known directory whose mtime changed", () => {
    expect(classifyFsEvent("src", "dir", true)).toBeNull();
  });

  it("emits unlink when a known file disappears", () => {
    expect(classifyFsEvent("a.txt", null, false)).toEqual<FsEvent>({
      type: "unlink",
      path: "a.txt",
    });
  });

  it("emits unlinkDir when a known directory disappears", () => {
    expect(classifyFsEvent("src", null, true)).toEqual<FsEvent>({
      type: "unlinkDir",
      path: "src",
    });
  });

  it("ignores deletes of paths we never observed", () => {
    expect(classifyFsEvent("ghost", null, null)).toBeNull();
  });

  it("treats a dir->file replacement as an add (client also gets the unlinkDir tick)", () => {
    expect(classifyFsEvent("thing", "file", true)).toEqual<FsEvent>({
      type: "add",
      path: "thing",
    });
  });
});

describe("makeDebouncer", () => {
  it("coalesces rapid calls for the same key into a single fire", async () => {
    vi.useFakeTimers();
    try {
      const d = makeDebouncer(50);
      const spy = vi.fn();
      d.schedule("a", spy);
      d.schedule("a", spy);
      d.schedule("a", spy);
      expect(spy).not.toHaveBeenCalled();
      expect(d.pendingCount()).toBe(1);
      vi.advanceTimersByTime(60);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(d.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the most recent fn for a key", () => {
    vi.useFakeTimers();
    try {
      const d = makeDebouncer(20);
      const a = vi.fn();
      const b = vi.fn();
      d.schedule("k", a);
      d.schedule("k", b);
      vi.advanceTimersByTime(25);
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let one key's burst delay another key", () => {
    vi.useFakeTimers();
    try {
      const d = makeDebouncer(30);
      const a = vi.fn();
      const b = vi.fn();
      d.schedule("a", a);
      vi.advanceTimersByTime(20);
      d.schedule("b", b);
      vi.advanceTimersByTime(15); // a should fire here, b not yet
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).not.toHaveBeenCalled();
      vi.advanceTimersByTime(20);
      expect(b).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel() drops pending timers without firing", () => {
    vi.useFakeTimers();
    try {
      const d = makeDebouncer(20);
      const spy = vi.fn();
      d.schedule("a", spy);
      d.schedule("b", spy);
      d.cancel();
      vi.advanceTimersByTime(100);
      expect(spy).not.toHaveBeenCalled();
      expect(d.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
