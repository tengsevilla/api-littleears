// OpenAI LyricsProvider — Responses API with strict JSON-schema structured output.
// Docs verified 2026-10-29:
//   https://developers.openai.com/api/docs/guides/structured-outputs
//     (responses.create + text.format { type: "json_schema", name, schema, strict: true };
//      read `output_text`; refusals arrive as content items of type "refusal";
//      status "incomplete" + incomplete_details.reason for truncated output)
//   SDK: openai@7.45 typings (client options `timeout` ms + `maxRetries`; errors expose `status`, `code`).
// `write` and `check` are separate calls with separate system prompts (R1).
import OpenAI from "openai";
import type { Response } from "openai/resources/responses/responses";
import { ProviderError, callVendor } from "../errors.js";
import {
  INVALID_SAFETY_RESPONSE,
  LYRICS_JSON_SCHEMA,
  SAFETY_JSON_SCHEMA,
  checkUserPrompt,
  parseLyricsDraft,
  parseSafetyResult,
  safetySystemPrompt,
  writeSystemPrompt,
  writeUserPrompt,
} from "../lyricsRules.js";
import type { LyricsDraft, LyricsProvider, SafetyResult } from "../types.js";

const WRITE_TIMEOUT_MS = 90_000;
const CHECK_TIMEOUT_MS = 60_000;

type ResponsesClient = Pick<OpenAI, "responses">;

/** Outcome of one structured call: text, or why there is none. */
type Outcome = { text: string } | { refused: true } | { incomplete: string };

function outcomeOf(res: Response): Outcome {
  for (const item of res.output ?? []) {
    if (item.type === "message" && item.content.some((c) => c.type === "refusal")) return { refused: true };
  }
  if (res.status === "incomplete") return { incomplete: res.incomplete_details?.reason ?? "unknown" };
  return { text: res.output_text ?? "" };
}

export class OpenAiLyricsProvider implements LyricsProvider {
  private readonly client: ResponsesClient;
  private readonly model: string;

  constructor(opts: { apiKey: string; model: string; client?: ResponsesClient }) {
    // maxRetries 0: the worker owns retries/backoff (uses ProviderError.transient).
    this.client = opts.client ?? new OpenAI({ apiKey: opts.apiKey, maxRetries: 0 });
    this.model = opts.model;
  }

  private request(system: string, user: string, name: string, schema: object, timeout: number) {
    return callVendor("openai", () =>
      this.client.responses.create(
        {
          model: this.model,
          input: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          text: { format: { type: "json_schema", name, schema: schema as Record<string, unknown>, strict: true } },
          store: false,
        },
        { timeout },
      ),
    );
  }

  async write(input: Parameters<LyricsProvider["write"]>[0]): Promise<LyricsDraft> {
    const res = await this.request(
      writeSystemPrompt(input.ageBand, input.mood),
      writeUserPrompt(input),
      "song_draft",
      LYRICS_JSON_SCHEMA,
      WRITE_TIMEOUT_MS,
    );
    const out = outcomeOf(res);
    if ("refused" in out || ("incomplete" in out && out.incomplete === "content_filter")) {
      throw new ProviderError("openai", "PROVIDER_REJECTED", false, "refused to write these lyrics");
    }
    if ("incomplete" in out) {
      throw new ProviderError("openai", "PROVIDER_UNAVAILABLE", true, "returned incomplete lyrics");
    }
    const draft = parseLyricsDraft(out.text, input.childName);
    // Malformed output (or a name in the image prompt) is a model hiccup: retry.
    if (!draft) throw new ProviderError("openai", "PROVIDER_UNAVAILABLE", true, "returned invalid lyrics output");
    return draft;
  }

  async check(input: Parameters<LyricsProvider["check"]>[0]): Promise<SafetyResult> {
    const res = await this.request(safetySystemPrompt(input.mood, input.personalized), checkUserPrompt(input), "safety_result", SAFETY_JSON_SCHEMA, CHECK_TIMEOUT_MS);
    const out = outcomeOf(res);
    // Anything other than valid JSON counts as a fail (R1).
    if (!("text" in out)) return INVALID_SAFETY_RESPONSE;
    return parseSafetyResult(out.text);
  }
}
