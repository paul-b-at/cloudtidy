import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { parseConfig } from "../src/config";
import { assertWritable, UnsafePathError } from "../src/paths";
import { makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(async () => {
  sb = await makeSandbox();
});
afterEach(() => sb.cleanup());

const ok = (p: string) => assertWritable(p, sb.layout, sb.config);
const rejects = (p: string) => expect(() => ok(p)).toThrow(UnsafePathError);

describe("assertWritable", () => {
  test("allows files inside buckets and their subfolders", () => {
    expect(ok(path.join(sb.layout.root, "01_Uni", "a.pdf"))).toEndWith(
      path.join("01_Uni", "a.pdf"),
    );
    ok(path.join(sb.layout.root, "02_Admin & Finanzen", "Rechnungen", "r.pdf"));
  });

  test("allows Needs_Review and its duplicates folder", () => {
    ok(path.join(sb.layout.needsReview, "x.pdf"));
    ok(path.join(sb.layout.duplicates, "x.pdf"));
  });

  test("rejects the root, the inbox itself, _Archiv and unknown folders", () => {
    rejects(path.join(sb.layout.root, "x.pdf"));
    rejects(path.join(sb.layout.inbox, "x.pdf"));
    rejects(path.join(sb.layout.root, "_Archiv", "x.pdf"));
    rejects(path.join(sb.layout.root, "Random", "x.pdf"));
    rejects(path.join(sb.layout.root, "01_Uni"));
  });

  test("rejects paths escaping the root", () => {
    rejects(path.join(sb.layout.root, "01_Uni", "..", "..", "x.pdf"));
    rejects("/etc/passwd");
  });

  test("rejects app containers and blocklisted folders anywhere in the path", () => {
    rejects(path.join(sb.layout.root, "com~apple~Pages", "x.pages"));
    rejects(path.join(sb.layout.root, "01_Uni", "Obsidian", "note.md"));
    rejects(path.join(sb.layout.root, "03_Projekte & Dev", "shortcuts", "x"));
  });

  test("rejects a bucket that is a symlink into a protected folder", async () => {
    await mkdir(path.join(sb.layout.root, "Obsidian"), { recursive: true });
    await symlink(
      path.join(sb.layout.root, "Obsidian"),
      path.join(sb.layout.root, "03_Projekte & Dev"),
    );
    rejects(path.join(sb.layout.root, "03_Projekte & Dev", "x.ts"));
  });

  test("treats NFD and NFC spellings of a bucket the same", () => {
    const nfd = path.join(sb.layout.root, "04_Persönlich".normalize("NFD"), "Reisen", "t.pdf");
    expect(ok(nfd)).toContain("04_Persönlich".normalize("NFC"));
  });
});

describe("config validation", () => {
  test("rejects an inbox that is also a bucket", () => {
    expect(() => parseConfig({ inbox: "01_Uni" })).toThrow();
  });
  test("rejects folder names with slashes", () => {
    expect(() =>
      parseConfig({ buckets: { uni: { dir: "a/b", description: "", subfolders: [] } } }),
    ).toThrow();
  });
  test("merges user overrides into defaults without dropping other buckets", () => {
    const config = parseConfig({ buckets: { uni: { subfolders: ["ML"] } } });
    expect(config.buckets.uni?.subfolders).toEqual(["ML"]);
    expect(config.buckets.uni?.dir).toBe("01_Uni");
    expect(config.buckets.admin?.dir).toBe("02_Admin & Finanzen");
  });
});
