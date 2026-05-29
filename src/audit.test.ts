import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { auditSkills } from "./audit.js";

let workDir: string;

beforeEach(async () => {
  workDir = realpathSync(await mkdtemp(join(tmpdir(), "skillforge-audit-")));
});

async function writeSkillMd(
  dir: string,
  opts: { name: string; description?: string; body?: string },
) {
  await mkdir(dir, { recursive: true });
  const description =
    opts.description ??
    "A long-enough description so the schema validator is happy with this for tests.";
  const body =
    opts.body ??
    `# ${opts.name}\n\nReal body content for the test.\nLine two.\nLine three.\nLine four.\nLine five.\n\n## Examples\n\nExample usage.\n`;
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${opts.name}\ndescription: ${description}\nversion: 0.0.1\ntags: []\n---\n\n${body}`,
  );
}

describe("auditSkills", () => {
  it("returns zero findings for an empty directory", async () => {
    const r = await auditSkills({ fromDir: workDir });
    expect(r.skillCount).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.summary).toEqual({ error: 0, warning: 0, info: 0 });
  });

  it("returns zero findings for a clean skill", async () => {
    await writeSkillMd(join(workDir, "clean"), { name: "clean" });
    const r = await auditSkills({ fromDir: workDir });
    expect(r.skillCount).toBe(1);
    expect(r.findings).toEqual([]);
  });

  it("flags an embedded binary > 1MB as security/embedded-binary error", async () => {
    const d = join(workDir, "binary");
    await writeSkillMd(d, { name: "binary" });
    await writeFile(join(d, "model.bin"), Buffer.alloc(2 * 1024 * 1024, 0));
    const r = await auditSkills({ fromDir: workDir });
    const f = r.findings.find((x) => x.ruleId === "security/embedded-binary");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("error");
    expect(f?.filePath).toBe("model.bin");
  });

  it("flags a shell-shebang script as security/shell-shebang warning", async () => {
    const d = join(workDir, "shellish");
    await writeSkillMd(d, { name: "shellish" });
    await writeFile(join(d, "run.sh"), "#!/bin/bash\necho hi\n");
    const r = await auditSkills({ fromDir: workDir });
    const f = r.findings.find((x) => x.ruleId === "security/shell-shebang");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.filePath).toBe("run.sh");
  });

  it.skipIf(process.platform === "win32")(
    "flags an exec-bit file as security/exec-bit warning (POSIX-only)",
    async () => {
      const d = join(workDir, "execbit");
      await writeSkillMd(d, { name: "execbit" });
      const fp = join(d, "tool");
      await writeFile(fp, "tool body\n");
      await chmod(fp, 0o755);
      const r = await auditSkills({ fromDir: workDir });
      const f = r.findings.find((x) => x.ruleId === "security/exec-bit");
      expect(f).toBeDefined();
      expect(f?.severity).toBe("warning");
    },
  );

  it("flags a TODO marker as quality/todo-marker info", async () => {
    await writeSkillMd(join(workDir, "todo"), {
      name: "todo",
      body: "# todo\n\nReal body content with a TODO that should surface.\nLine two.\nLine three.\nLine four.\nLine five.\n\n## Examples\n\nexample\n",
    });
    const r = await auditSkills({ fromDir: workDir });
    const f = r.findings.find((x) => x.ruleId === "quality/todo-marker");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("info");
  });

  it("flags missing Examples heading as quality/missing-examples info", async () => {
    await writeSkillMd(join(workDir, "noexamples"), {
      name: "noexamples",
      body: "# noexamples\n\nReal body content without an examples header.\nLine two.\nLine three.\nLine four.\nLine five.\n",
    });
    const r = await auditSkills({ fromDir: workDir });
    expect(r.findings.find((x) => x.ruleId === "quality/missing-examples")).toBeDefined();
  });

  it("severityFilter=error filters out info + warning", async () => {
    await writeSkillMd(join(workDir, "todo"), {
      name: "todo",
      body: "# todo\n\nReal body content with a TODO marker.\nLine two.\nLine three.\nLine four.\nLine five.\n\n## Examples\n\nexample\n",
    });
    const r = await auditSkills({ fromDir: workDir, severityFilter: "error" });
    expect(r.findings.every((f) => f.severity === "error")).toBe(true);
  });

  it("aggregates findings per skill across a multi-skill directory", async () => {
    await writeSkillMd(join(workDir, "a"), { name: "a" });
    await writeSkillMd(join(workDir, "b"), {
      name: "b",
      body: "# b\n\nTODO body shorter line counts present here for the test.\nLine two.\nLine three.\nLine four.\nLine five.\n",
    });
    const r = await auditSkills({ fromDir: workDir });
    expect(r.skillCount).toBe(2);
    const bFindings = r.findings.filter((f) => f.skillName === "b");
    expect(bFindings.length).toBeGreaterThan(0);
  });

  it("rejects a non-directory fromDir with a clear error", async () => {
    const fp = join(workDir, "notadir");
    await writeFile(fp, "x");
    await expect(auditSkills({ fromDir: fp })).rejects.toThrow(/not a directory/);
  });

  it("returns AuditReport shape suitable for --json output", async () => {
    await writeSkillMd(join(workDir, "x"), { name: "x" });
    const r = await auditSkills({ fromDir: workDir });
    expect(r).toHaveProperty("fromDir");
    expect(r).toHaveProperty("scanned");
    expect(r).toHaveProperty("findings");
    expect(r).toHaveProperty("summary");
  });
});
