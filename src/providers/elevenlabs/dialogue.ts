// ElevenLabs DialogueProvider — POST /v1/text-to-dialogue via `client.textToDialogue.convert`.
// Used only by the offline story generator (src/scripts/generateStories.ts).
// Docs verified 2026-11-04:
//   https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert
//     body { inputs: [{ text, voice_id }], model_id, settings?, seed?, ... }; output_format query
//     (mp3_44100_192 needs Creator tier+ — live 403 output_format_not_allowed on this account, so we
//     request mp3_44100_128; the mix re-encodes anyway). Response body is the audio file. eleven_v3 supports
//     inline audio tags such as [excited], [laughs], [whispers].
//   SDK: @elevenlabs/elevenlabs-js@2.75 typings (BodyTextToDialogueMultiVoiceV1TextToDialoguePost
//     { inputs: DialogueInput { text, voiceId }[], modelId?, outputFormat?, settings? };
//     "The maximum number of unique voice IDs is 10. For reliable generation, keep the total
//     character count across all inputs[].text values at or below 2,000 characters per request.";
//     convert(request, requestOptions) → ReadableStream<Uint8Array>).
import { ElevenLabsClient, type ElevenLabs } from "@elevenlabs/elevenlabs-js";
import { callVendor, readAll } from "../errors.js";
import type { DialogueLine, DialogueProvider } from "../types.js";

const TIMEOUT_SEC = 180;
export const MAX_DIALOGUE_CHARS = 2000;
export const MAX_DIALOGUE_VOICES = 10;

type DialogueClient = Pick<ElevenLabsClient, "textToDialogue">;

/**
 * Splits lines, in order, into requests that each stay within the API limits
 * (≤ MAX_DIALOGUE_CHARS characters of text in total, ≤ MAX_DIALOGUE_VOICES distinct voices).
 * Throws for empty input, an empty line, or a single line that alone exceeds the character limit.
 */
export function chunkDialogue(lines: DialogueLine[], maxChars = MAX_DIALOGUE_CHARS, maxVoices = MAX_DIALOGUE_VOICES): DialogueLine[][] {
  if (lines.length === 0) throw new Error("dialogue needs at least one line");
  const chunks: DialogueLine[][] = [];
  let current: DialogueLine[] = [];
  let chars = 0;
  let voices = new Set<string>();
  for (const line of lines) {
    if (!line.text.trim() || !line.voiceId) throw new Error("dialogue line needs text and a voiceId");
    if (line.text.length > maxChars) throw new Error(`dialogue line has ${line.text.length} characters (max ${maxChars})`);
    const newVoice = !voices.has(line.voiceId);
    if (current.length && (chars + line.text.length > maxChars || (newVoice && voices.size >= maxVoices))) {
      chunks.push(current);
      current = [];
      chars = 0;
      voices = new Set();
    }
    current.push(line);
    chars += line.text.length;
    voices.add(line.voiceId);
  }
  chunks.push(current);
  return chunks;
}

export class ElevenLabsDialogueProvider implements DialogueProvider {
  private readonly client: DialogueClient;
  private readonly model: string;

  constructor(opts: { apiKey: string; model: string; client?: DialogueClient }) {
    this.client = opts.client ?? new ElevenLabsClient({ apiKey: opts.apiKey, maxRetries: 0 });
    this.model = opts.model;
  }

  /** One request per chunk; the MP3 chunks are concatenated frame streams (ffmpeg decodes them as one). */
  async generate(input: { lines: DialogueLine[] }): Promise<Buffer> {
    const parts: Buffer[] = [];
    for (const chunk of chunkDialogue(input.lines)) {
      const request: ElevenLabs.BodyTextToDialogueMultiVoiceV1TextToDialoguePost = {
        inputs: chunk.map((l) => ({ text: l.text, voiceId: l.voiceId })),
        modelId: this.model,
        outputFormat: "mp3_44100_128",
      };
      parts.push(
        await callVendor("elevenlabs", async () =>
          readAll(await this.client.textToDialogue.convert(request, { timeoutInSeconds: TIMEOUT_SEC, maxRetries: 0 })),
        ),
      );
    }
    return Buffer.concat(parts);
  }
}
