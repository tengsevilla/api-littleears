// ElevenLabs SoundEffectsProvider — POST /v1/sound-generation via `client.textToSoundEffects.convert`.
// Used only by the offline soundscape generator (src/scripts/generateSoundscapes.ts).
// Docs verified 2026-11-04:
//   https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert
//     text (required); duration_seconds 0.5–30 (omitted = model guesses); loop (boolean, a clip
//     that loops smoothly); prompt_influence 0–1 (default 0.3); model_id eleven_text_to_sound_v2 |
//     eleven_text_to_sound_v3; output_format query param (mp3_44100_192 needs Creator tier+).
//     Response body is the audio file.
//   SDK: @elevenlabs/elevenlabs-js@2.75 typings (CreateSoundEffectRequest { text, loop?,
//     durationSeconds?, promptInfluence?, modelId?: SfxModelId, outputFormat? };
//     convert(request, requestOptions) → ReadableStream<Uint8Array>; client options
//     timeoutInSeconds / maxRetries).
import { ElevenLabsClient, type ElevenLabs } from "@elevenlabs/elevenlabs-js";
import { callVendor, readAll } from "../errors.js";
import type { SoundEffectsProvider } from "../types.js";

const TIMEOUT_SEC = 180;
const PROMPT_INFLUENCE = 0.5;

type SoundEffectsClient = Pick<ElevenLabsClient, "textToSoundEffects">;

export class ElevenLabsSoundEffectsProvider implements SoundEffectsProvider {
  private readonly client: SoundEffectsClient;
  private readonly model: string;

  constructor(opts: { apiKey: string; model: string; client?: SoundEffectsClient }) {
    this.client = opts.client ?? new ElevenLabsClient({ apiKey: opts.apiKey, maxRetries: 0 });
    this.model = opts.model;
  }

  async generate(input: { text: string; durationSec: number; loop: boolean }): Promise<Buffer> {
    return callVendor("elevenlabs", async () => {
      const stream = await this.client.textToSoundEffects.convert(
        {
          text: input.text,
          durationSeconds: input.durationSec,
          loop: input.loop,
          promptInfluence: PROMPT_INFLUENCE,
          modelId: this.model as ElevenLabs.SfxModelId,
          outputFormat: "mp3_44100_192",
        },
        { timeoutInSeconds: TIMEOUT_SEC, maxRetries: 0 },
      );
      return readAll(stream);
    });
  }
}
