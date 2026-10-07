import { z } from "zod";
import type { Config } from "../config";

export interface LlmInput {
  filename: string;
  text: string;
}

export interface LlmResult {
  category: string;
  sub: string | null;
  suggestedName: string;
  confidence: number;
}

export type LlmOutcome = { ok: true; result: LlmResult } | { ok: false; reason: string };

export interface Tier2 {
  classify(input: LlmInput): Promise<LlmOutcome>;
}

const ChatResponse = z.object({ message: z.object({ content: z.string() }) });
const Answer = z.object({
  category: z.string(),
  subcategory: z.string(),
  suggestedName: z.string(),
  confidence: z.number(),
});

/** Enums keep the model from inventing buckets or folders; "" means "no subfolder". */
export function answerSchema(buckets: Config["buckets"]) {
  const dirs = Object.values(buckets).map((b) => b.dir);
  const subs = [...new Set(Object.values(buckets).flatMap((b) => b.subfolders))];
  return {
    type: "object",
    properties: {
      category: { type: "string", enum: dirs },
      subcategory: { type: "string", enum: ["", ...subs] },
      suggestedName: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["category", "subcategory", "suggestedName", "confidence"],
  };
}

export function systemPrompt(buckets: Config["buckets"]): string {
  const lines = Object.values(buckets).map((b) => {
    const subs = b.subfolders.length > 0 ? ` Subfolders: ${b.subfolders.join(", ")}.` : "";
    return `- "${b.dir}": ${b.description}.${subs}`;
  });
  return [
    "You sort personal documents of an Austrian computer science student into folders.",
    "Pick exactly one category from this list:",
    ...lines,
    'Pick a subcategory only from the chosen category\'s subfolders, otherwise use "".',
    'suggestedName: the sender or issuer and a short subject, e.g. "Drei Rechnung Oktober". No date, no file extension.',
    "confidence: 0 to 1, how sure you are about the category. Use a low value if the content is unclear.",
    "Answer with JSON only.",
  ].join("\n");
}

export class OllamaTier2 implements Tier2 {
  private warm = false;

  constructor(
    private readonly llm: Config["llm"],
    private readonly buckets: Config["buckets"],
  ) {}

  async classify(input: LlmInput): Promise<LlmOutcome> {
    const body = {
      model: this.llm.model,
      stream: false,
      keep_alive: this.llm.keepAlive,
      format: answerSchema(this.buckets),
      options: { temperature: 0 },
      messages: [
        { role: "system", content: systemPrompt(this.buckets) },
        {
          role: "user",
          content: `Filename: ${input.filename}\n\nContent (truncated):\n${input.text.slice(0, this.llm.maxChars)}`,
        },
      ],
    };

    // The first call of a run may have to load the model into memory.
    const timeout = this.warm ? this.llm.warmTimeoutMs : this.llm.coldTimeoutMs;
    let response: Response;
    try {
      response = await fetch(`${this.llm.endpoint.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      return { ok: false, reason: `LLM unreachable: ${(error as Error).message}` };
    }
    if (!response.ok) return { ok: false, reason: `LLM returned HTTP ${response.status}` };
    this.warm = true;

    const chat = ChatResponse.safeParse(await response.json().catch(() => null));
    if (!chat.success) return { ok: false, reason: "LLM response had an unexpected shape" };
    let raw: unknown;
    try {
      raw = JSON.parse(chat.data.message.content);
    } catch {
      return { ok: false, reason: "LLM answer was not valid JSON" };
    }
    const answer = Answer.safeParse(raw);
    if (!answer.success) return { ok: false, reason: "LLM answer did not match the schema" };
    return this.toResult(answer.data);
  }

  private toResult(answer: z.infer<typeof Answer>): LlmOutcome {
    const entry = Object.entries(this.buckets).find(([, b]) => b.dir === answer.category);
    if (!entry) return { ok: false, reason: `LLM picked unknown category "${answer.category}"` };
    const [id, bucket] = entry;
    const sub = bucket.subfolders.includes(answer.subcategory) ? answer.subcategory : null;
    return {
      ok: true,
      result: {
        category: id,
        sub,
        suggestedName: answer.suggestedName,
        confidence: Math.min(1, Math.max(0, answer.confidence)),
      },
    };
  }
}
