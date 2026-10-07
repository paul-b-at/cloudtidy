import { afterEach, describe, expect, test } from "bun:test";
import { classify } from "../src/classify";
import { buildRules } from "../src/classify/heuristics";
import { answerSchema, OllamaTier2 } from "../src/classify/llm";
import { parseConfig } from "../src/config";
import { type FakeAnswer, fakeOllama } from "./helpers";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

function setup(respond: Parameters<typeof fakeOllama>[0], endpoint?: string) {
  const server = endpoint ? null : fakeOllama(respond);
  if (server) stop = server.stop;
  const config = parseConfig({
    llm: { endpoint: endpoint ?? server?.url, coldTimeoutMs: 1000, warmTimeoutMs: 1000 },
  });
  const tier2 = new OllamaTier2(config.llm, config.buckets);
  return { config, tier2, requests: server?.requests ?? [] };
}

const answer = (overrides: Partial<FakeAnswer> = {}): FakeAnswer => ({
  category: "04_Persönlich",
  subcategory: "Gesundheit",
  suggestedName: "Laborbefund",
  confidence: 0.9,
  ...overrides,
});

describe("OllamaTier2", () => {
  test("sends a constrained schema, temperature 0 and keep_alive", async () => {
    const { tier2, requests } = setup(() => answer());
    const outcome = await tier2.classify({ filename: "a.pdf", text: "x".repeat(5000) });
    expect(outcome).toEqual({
      ok: true,
      result: {
        category: "personal",
        sub: "Gesundheit",
        suggestedName: "Laborbefund",
        confidence: 0.9,
      },
    });
    const body = requests[0] as Record<string, unknown> & { messages: { content: string }[] };
    expect(body.options).toEqual({ temperature: 0 });
    expect(body.keep_alive).toBe("30m");
    expect(body.format).toEqual(answerSchema(parseConfig().buckets));
    expect(body.messages[1]?.content.length).toBeLessThan(1100);
  });

  test("drops a subfolder that belongs to another bucket", async () => {
    const { tier2 } = setup(() => answer({ category: "01_Uni", subcategory: "Rechnungen" }));
    const outcome = await tier2.classify({ filename: "a.pdf", text: "" });
    expect(outcome.ok && outcome.result).toMatchObject({ category: "uni", sub: null });
  });

  test("rejects unknown categories and malformed answers", async () => {
    const unknown = setup(() => answer({ category: "Downloads" }));
    expect((await unknown.tier2.classify({ filename: "a", text: "" })).ok).toBe(false);
    await stop?.();
    const garbage = setup(() => Response.json({ message: { content: "not json" } }));
    expect(await garbage.tier2.classify({ filename: "a", text: "" })).toEqual({
      ok: false,
      reason: "LLM answer was not valid JSON",
    });
  });

  test("reports an unreachable server instead of throwing", async () => {
    const { tier2 } = setup(() => answer(), "http://127.0.0.1:9");
    const outcome = await tier2.classify({ filename: "a", text: "" });
    expect(outcome.ok).toBe(false);
  });
});

describe("classify routing", () => {
  test("tier 1 wins without calling the LLM", async () => {
    const { config, tier2, requests } = setup(() => answer());
    const decision = await classify(
      { filename: "Reisepass_Scan.pdf", text: "" },
      { config, rules: buildRules(config), tier2 },
    );
    expect(decision).toMatchObject({
      kind: "sorted",
      tier: 1,
      category: "personal",
      sub: "Dokumente",
    });
    expect(requests).toHaveLength(0);
  });

  test("ambiguous files go to the LLM; low confidence goes to review", async () => {
    const { config, tier2 } = setup((input) =>
      input.text.includes("Blutbild") ? answer() : answer({ confidence: 0.3 }),
    );
    const ctx = { config, rules: buildRules(config), tier2 };
    expect(await classify({ filename: "a.pdf", text: "Blutbild" }, ctx)).toMatchObject({
      kind: "sorted",
      tier: 2,
      category: "personal",
    });
    expect(await classify({ filename: "b.pdf", text: "???" }, ctx)).toMatchObject({
      kind: "review",
      tier: 2,
    });
  });

  test("without an LLM, ambiguous files go to review", async () => {
    const config = parseConfig();
    expect(
      await classify(
        { filename: "IMG_1.heic", text: "" },
        { config, rules: buildRules(config), tier2: null },
      ),
    ).toMatchObject({ kind: "review" });
  });
});
