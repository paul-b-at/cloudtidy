import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LockTimeoutError, moveNoClobber, withCounter, withLock } from "../src/mover";
import { assertWritable } from "../src/paths";
import { makeSandbox, put, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(async () => {
  sb = await makeSandbox();
});
afterEach(() => sb.cleanup());

const guard = (p: string) => {
  assertWritable(p, sb.layout, sb.config);
};

describe("moveNoClobber", () => {
  test("moves into a new folder", async () => {
    const src = await put(path.join(sb.layout.inbox, "a.pdf"), "A");
    const dest = path.join(sb.layout.bucketDirs.uni ?? "", "Sub");
    const result = await moveNoClobber(src, dest, "a.pdf", sb.layout.duplicates, guard);
    expect(result.status).toBe("moved");
    expect(await readFile(path.join(dest, "a.pdf"), "utf8")).toBe("A");
    expect(existsSync(src)).toBe(false);
  });

  test("never overwrites a different file with the same name", async () => {
    const dest = sb.layout.bucketDirs.uni ?? "";
    await put(path.join(dest, "a.pdf"), "existing");
    await put(path.join(dest, "a (2).pdf"), "existing 2");
    const src = await put(path.join(sb.layout.inbox, "a.pdf"), "new");
    const result = await moveNoClobber(src, dest, "a.pdf", sb.layout.duplicates, guard);
    expect(result.to).toBe(path.join(dest, "a (3).pdf"));
    expect(await readFile(path.join(dest, "a.pdf"), "utf8")).toBe("existing");
    expect(await readFile(path.join(dest, "a (2).pdf"), "utf8")).toBe("existing 2");
    expect(await readFile(result.to, "utf8")).toBe("new");
  });

  test("parks byte-identical files in duplicates instead of deleting them", async () => {
    const dest = sb.layout.bucketDirs.uni ?? "";
    await put(path.join(dest, "a.pdf"), "same");
    const src = await put(path.join(sb.layout.inbox, "a.pdf"), "same");
    const result = await moveNoClobber(src, dest, "a.pdf", sb.layout.duplicates, guard);
    expect(result.status).toBe("duplicate");
    expect(result.to).toBe(path.join(sb.layout.duplicates, "a.pdf"));
    expect(await readFile(result.to, "utf8")).toBe("same");
  });

  test("refuses blocked targets and leaves the source in place", async () => {
    const src = await put(path.join(sb.layout.inbox, "a.pdf"), "A");
    const blocked = path.join(sb.layout.root, "com~apple~Numbers");
    await expect(
      moveNoClobber(src, blocked, "a.pdf", sb.layout.duplicates, guard),
    ).rejects.toThrow();
    expect(existsSync(src)).toBe(true);
  });

  test("withCounter keeps the extension", () => {
    expect(withCounter("Rechnung.pdf", 1)).toBe("Rechnung.pdf");
    expect(withCounter("Rechnung.pdf", 2)).toBe("Rechnung (2).pdf");
    expect(withCounter("Makefile", 3)).toBe("Makefile (3)");
  });
});

describe("withLock", () => {
  test("serializes concurrent runs instead of dropping one", async () => {
    const lock = sb.config.lockFile;
    const order: string[] = [];
    const first = withLock(lock, 2000, async () => {
      order.push("first:start");
      await Bun.sleep(300);
      order.push("first:end");
    });
    await Bun.sleep(20);
    const second = withLock(lock, 2000, async () => {
      order.push("second");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(existsSync(lock)).toBe(false);
  });

  test("times out when another live process holds the lock", async () => {
    await put(sb.config.lockFile, String(process.pid));
    await expect(withLock(sb.config.lockFile, 300, async () => {})).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
  });

  test("takes over a stale lock from a dead process", async () => {
    await put(sb.config.lockFile, "999999");
    let ran = false;
    await withLock(sb.config.lockFile, 300, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("releases the lock when the task throws", async () => {
    await expect(
      withLock(sb.config.lockFile, 300, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(sb.config.lockFile)).toBe(false);
  });
});
