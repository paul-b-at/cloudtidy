import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { scanInbox } from "../src/scanner";
import { stubTarget, waitForStable } from "../src/stability";
import { makeSandbox, put, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(async () => {
  sb = await makeSandbox();
});
afterEach(() => sb.cleanup());

test("scanInbox lists only top-level regular files and collects iCloud stubs", async () => {
  const inbox = sb.layout.inbox;
  await put(path.join(inbox, "b.pdf"), "x");
  await put(path.join(inbox, "a.txt"), "x");
  await put(path.join(inbox, ".DS_Store"), "x");
  await put(path.join(inbox, ".Scan.pdf.icloud"), "x");
  await put(path.join(inbox, "video.mov.download"), "x");
  await put(path.join(inbox, "file.crdownload"), "x");
  await put(path.join(sb.layout.needsReview, "c.pdf"), "x");
  await mkdir(path.join(inbox, "folder"));

  const result = await scanInbox(inbox);
  expect(result.files.map((f) => path.basename(f))).toEqual(["a.txt", "b.pdf"]);
  expect(result.stubs.map((f) => path.basename(f))).toEqual([".Scan.pdf.icloud"]);
});

test("scanInbox tolerates a missing inbox", async () => {
  expect(await scanInbox(path.join(sb.dir, "nope"))).toEqual({ files: [], stubs: [] });
});

test("stubTarget maps a placeholder to the real file name", () => {
  expect(stubTarget("/x/_Inbox/.Rechnung März.pdf.icloud")).toBe("/x/_Inbox/Rechnung März.pdf");
});

test("waitForStable keeps polling a file that is still being written", async () => {
  const stable = await put(path.join(sb.layout.inbox, "done.pdf"), "complete");
  const growing = await put(path.join(sb.layout.inbox, "growing.pdf"), "a");
  const empty = await put(path.join(sb.layout.inbox, "empty.pdf"), "");

  let writes = 0;
  const sleep = async () => {
    if (writes++ < 3) await appendFile(growing, "more");
    await Bun.sleep(2);
  };
  const result = await waitForStable(
    [stable, growing, empty],
    { intervalMs: 0, maxWaitMs: 500 },
    sleep,
  );
  expect(result.ready.sort()).toEqual([stable, growing].sort());
  expect(result.pending).toEqual([empty]);
});
