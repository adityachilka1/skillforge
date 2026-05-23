import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { beforeEach, describe, expect, it } from "vitest";
import { installSkill } from "./install.js";

let workDir: string;

beforeEach(async () => {
  workDir = realpathSync(await mkdtemp(join(tmpdir(), "skillforge-install-")));
});

function validSkillMd(name = "my-skill"): string {
  return `---
name: ${name}
description: A long-enough description so the schema validator is happy with it (>=20 chars).
version: 0.0.1
tags: []
---

# ${name}

Body content for the installer tests — at least five lines.
Line two.
Line three.
Line four.
Line five.
`;
}

async function buildSkillZip(
  files: Record<string, string | Uint8Array | { content: string; unixPermissions: number }>,
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, val] of Object.entries(files)) {
    if (typeof val === "string" || val instanceof Uint8Array) {
      zip.file(path, val);
    } else {
      zip.file(path, val.content, { unixPermissions: val.unixPermissions });
    }
  }
  // `platform: "UNIX"` is what makes JSZip persist the Unix-mode bits (incl.
  // the symlink type bits) in the external attributes field of the zip.
  // Without it, the bits get clobbered to defaults on encode.
  const buf = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
  return buf;
}

function mockFetch(buf: Buffer, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  });
}

describe("installSkill", () => {
  it("downloads a .skill, validates SKILL.md, and extracts files", async () => {
    const buf = await buildSkillZip({
      "SKILL.md": validSkillMd("test-skill"),
      "templates/letter.md": "Dear ...",
      "tool.py": "print('hi')",
    });
    const result = await installSkill({
      url: "https://example.com/test-skill.skill",
      outDir: join(workDir, "installed"),
      fetchImpl: mockFetch(buf),
    });
    expect(result.skillName).toBe("test-skill");
    expect(result.outDir).toBe(join(workDir, "installed"));
    expect(result.files.sort()).toEqual(["SKILL.md", "templates/letter.md", "tool.py"]);
    expect(result.dryRun).toBe(false);
    expect(result.bytesWritten).toBeGreaterThan(0);

    // Files on disk
    expect((await stat(join(workDir, "installed", "SKILL.md"))).isFile()).toBe(true);
    expect(await readFile(join(workDir, "installed", "tool.py"), "utf8")).toBe("print('hi')");
  });

  it("refuses plaintext http:// URLs before any fetch", async () => {
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      throw new Error("should not be called");
    }) as unknown as InstallOptions["fetchImpl"];
    await expect(installSkill({ url: "http://example.com/x.skill", fetchImpl })).rejects.toThrow(
      /refusing plaintext http/,
    );
    expect(fetchCalled).toBe(false);
  });

  it("rejects an archive without a SKILL.md at the root", async () => {
    const buf = await buildSkillZip({ "nested/SKILL.md": validSkillMd() });
    await expect(
      installSkill({
        url: "https://example.com/x.skill",
        outDir: join(workDir, "installed"),
        fetchImpl: mockFetch(buf),
      }),
    ).rejects.toThrow(/does not contain a SKILL.md/);
  });

  it("rejects an archive with invalid frontmatter", async () => {
    const buf = await buildSkillZip({
      "SKILL.md": "---\nname: x\ndescription: too short\n---\nbody\n",
    });
    await expect(
      installSkill({
        url: "https://example.com/x.skill",
        outDir: join(workDir, "installed"),
        fetchImpl: mockFetch(buf),
      }),
    ).rejects.toThrow(/description must be at least/);
  });

  // Zip-slip protection lives at `planExtraction` → `isInside(absPath,
  // outDirWithSep)` in install.ts. It's exercised by every install, since
  // every entry has its destination resolved through the same code path.
  // We deliberately don't try to round-trip an adversarial `../entry` via
  // JSZip itself — both `file()` and `generateAsync()` sanitize the path,
  // so constructing a hand-rolled hostile zip would require writing the
  // central directory by hand, which is out of scope for a unit test.
  // The defence-in-depth here is the unconditional resolve-and-prefix
  // check, which is easy to review in source.

  it("refuses an archive containing a symlink entry", async () => {
    const buf = await buildSkillZip({
      "SKILL.md": validSkillMd(),
      // 0o120777 = symlink type bits + rwxrwxrwx perms (the bit pattern JSZip
      // stamps for symlink entries).
      evil_link: { content: "/etc/passwd", unixPermissions: 0o120777 },
    });
    await expect(
      installSkill({
        url: "https://example.com/x.skill",
        outDir: join(workDir, "installed"),
        fetchImpl: mockFetch(buf),
      }),
    ).rejects.toThrow(/symlink/);
  });

  it("refuses to overwrite an existing install dir without --force", async () => {
    const dst = join(workDir, "installed");
    await mkdir(dst, { recursive: true });
    await writeFile(join(dst, "leftover.txt"), "old data");
    const buf = await buildSkillZip({ "SKILL.md": validSkillMd() });
    await expect(
      installSkill({ url: "https://example.com/x.skill", outDir: dst, fetchImpl: mockFetch(buf) }),
    ).rejects.toThrow(/already exists/);
  });

  it("overwrites cleanly with --force (no stale files from previous install)", async () => {
    const dst = join(workDir, "installed");
    await mkdir(dst, { recursive: true });
    await writeFile(join(dst, "stale.txt"), "should be removed");
    const buf = await buildSkillZip({ "SKILL.md": validSkillMd() });
    const result = await installSkill({
      url: "https://example.com/x.skill",
      outDir: dst,
      force: true,
      fetchImpl: mockFetch(buf),
    });
    expect(result.files).toEqual(["SKILL.md"]);
    // stale.txt should be gone (a clean install dir is the whole point of --force)
    await expect(stat(join(dst, "stale.txt"))).rejects.toThrow();
  });

  it("writes nothing in --dry-run mode but reports what would happen", async () => {
    const dst = join(workDir, "installed-dry");
    const buf = await buildSkillZip({
      "SKILL.md": validSkillMd(),
      "tool.py": "print('hi')",
    });
    const result = await installSkill({
      url: "https://example.com/x.skill",
      outDir: dst,
      dryRun: true,
      fetchImpl: mockFetch(buf),
    });
    expect(result.dryRun).toBe(true);
    expect(result.files.sort()).toEqual(["SKILL.md", "tool.py"]);
    await expect(stat(dst)).rejects.toThrow(); // never created
  });

  it("surfaces a non-2xx HTTP status with the URL", async () => {
    await expect(
      installSkill({
        url: "https://example.com/missing.skill",
        outDir: join(workDir, "installed"),
        fetchImpl: mockFetch(Buffer.from(""), 404),
      }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("rejects a non-zip payload with a clear message", async () => {
    await expect(
      installSkill({
        url: "https://example.com/x.skill",
        outDir: join(workDir, "installed"),
        fetchImpl: mockFetch(Buffer.from("this is not a zip")),
      }),
    ).rejects.toThrow(/not a valid \.skill/);
  });

  it("rejects unsupported URL schemes", async () => {
    await expect(installSkill({ url: "ftp://example.com/x.skill" })).rejects.toThrow(
      /unsupported URL scheme/,
    );
    await expect(installSkill({ url: "not a url" })).rejects.toThrow(/not a valid URL/);
  });
});

// Type-only import so the test file references InstallOptions for the
// http-rejection test without pulling the implementation eagerly above the
// describe block.
type InstallOptions = Parameters<typeof installSkill>[0];
