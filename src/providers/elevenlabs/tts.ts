// ElevenLabs TtsProvider — POST /v1/text-to-speech/{voice_id} via `client.textToSpeech.convert`.
// Docs verified 2026-10-29:
//   https://elevenlabs.io/docs/api-reference/text-to-speech/convert
//     body { text, model_id, ... }; output_format query, e.g. mp3_44100_128; response is audio.
//   https://elevenlabs.io/docs/models  (eleven_v4_turbo: real-time TTS, ~100 ms)
//   SDK: @elevenlabs/elevenlabs-js@2.75 typings —
//     convert(voiceId, { text, modelId, outputFormat }, { timeoutInSeconds, maxRetries }) → ReadableStream<Uint8Array>.
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { callVendor, readAll } from "../errors.js";
import type { TtsProvider } from "../types.js";

const TIMEOUT_SEC = 20;

type TtsClient = Pick<ElevenLabsClient, "textToSpeech">;

export class ElevenLabsTtsProvider implements TtsProvider {
  private readonly client: TtsClient;
  private readonly model: string;
  private readonly voiceId: string;

  constructor(opts: { apiKey: string; model: string; voiceId: string; client?: TtsClient }) {
    this.client = opts.client ?? new ElevenLabsClient({ apiKey: opts.apiKey, maxRetries: 0 });
    this.model = opts.model;
    this.voiceId = opts.voiceId;
  }

  async speak(input: { text: string }): Promise<Buffer> {
    return callVendor("elevenlabs", async () => {
      const stream = await this.client.textToSpeech.convert(
        this.voiceId,
        { text: input.text, modelId: this.model, outputFormat: "mp3_44100_128" },
        { timeoutInSeconds: TIMEOUT_SEC, maxRetries: 0 },
      );
      return readAll(stream);
    });
  }
}
