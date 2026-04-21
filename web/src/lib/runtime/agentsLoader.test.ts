/**
 * Tests for the agents/*.md loader (PR 4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-agents-test-")),
  );
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("parseAgentMarkdown", () => {
  it("parses frontmatter and uses the body as the prompt", async () => {
    const { parseAgentMarkdown } = await import("./agentsLoader");
    const text = `---
name: Dev
role: developer
model: gpt-5.3-codex
tools: [read_file, write_file]
---

# Dev

Hello.
`;
    const a = parseAgentMarkdown(text, { id: "dev", filePath: "/x/dev.md" });
    expect(a.id).toBe("dev");
    expect(a.name).toBe("Dev");
    expect(a.role).toBe("developer");
    expect(a.model).toBe("gpt-5.3-codex");
    expect(a.tools).toEqual(["read_file", "write_file"]);
    expect(a.prompt).toMatch(/^# Dev/);
  });

  it("falls back to defaults when frontmatter is missing", async () => {
    const { parseAgentMarkdown } = await import("./agentsLoader");
    const text = `# Plain agent\n\nNo frontmatter.\n`;
    const a = parseAgentMarkdown(text, { id: "plain", filePath: "/x/plain.md" });
    expect(a.name).toBe("plain");
    expect(a.tools).toEqual([]);
    expect(a.prompt).toMatch(/^# Plain/);
  });

  it("accepts CSV tool lists as well as flow-style", async () => {
    const { parseAgentMarkdown } = await import("./agentsLoader");
    const text = `---
tools: read_file, exec
---
body`;
    const a = parseAgentMarkdown(text, { id: "x", filePath: "/x.md" });
    expect(a.tools).toEqual(["read_file", "exec"]);
  });
});

describe("seedDefaultAgents + loadAgentsFromWorkspace", () => {
  it("seeds Dev/QA/PO and loads them back", async () => {
    const { seedDefaultAgents, loadAgentsFromWorkspace } = await import(
      "./agentsLoader"
    );
    const created = await seedDefaultAgents(workspace);
    expect(created.sort()).toEqual([
      "agents/dev.md",
      "agents/po.md",
      "agents/qa.md",
    ]);
    const agents = await loadAgentsFromWorkspace(workspace);
    expect(agents.map((a) => a.id).sort()).toEqual(["dev", "po", "qa"]);
    const dev = agents.find((a) => a.id === "dev")!;
    expect(dev.role).toBe("developer");
    expect(dev.tools).toContain("write_file");
  });

  it("seedDefaultAgents is idempotent", async () => {
    const { seedDefaultAgents } = await import("./agentsLoader");
    await seedDefaultAgents(workspace);
    const second = await seedDefaultAgents(workspace);
    expect(second).toEqual([]);
  });

  it("loader returns [] when the workspace has no agents/ dir", async () => {
    const { loadAgentsFromWorkspace } = await import("./agentsLoader");
    const out = await loadAgentsFromWorkspace(workspace);
    expect(out).toEqual([]);
  });
});
