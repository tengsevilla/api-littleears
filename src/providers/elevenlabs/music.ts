// ElevenLabs MusicProvider — POST /v1/music via `client.music.compose`.
// Docs verified 2026-10-29:
//   https://elevenlabs.io/docs/api-reference/music/compose
//     model_id: music_v1 | music_v2 | music_v2_5. For music_v2 / music_v2_5 the composition_plan
//     is `{ chunks: [...] }`; a generation chunk is { text, duration_ms (3000–120000),
//     positive_styles, negative_styles?, context_adherence? }. `text` may start with a
//     "[Section]" name; ≤30 lines, ≤200 chars per line. `prompt` and `composition_plan`
//     are mutually exclusive. Response body is the audio file.
//   https://elevenlabs.io/docs/cookbooks/music/quickstart
//     `elevenlabs.music.compose({ compositionPlan, modelId: "music_v2_5" })` → audio stream.
//   SDK: @elevenlabs/elevenlabs-js@2.75 typings (BodyComposeMusicV1MusicPost.compositionPlan,
//     CompositionPlan.chunks, GenerationChunkInput { text, durationMs, positiveStyles, ... },
//     outputFormat "mp3_44100_192"; client options timeoutInSeconds / maxRetries).
import { ElevenLabsClient, type ElevenLabs } from "@elevenlabs/elevenlabs-js";
import { callVendor, readAll } from "../errors.js";
import type { MusicProvider } from "../types.js";

const TIMEOUT_SEC = 300;
const MAX_CHUNK_MS = 120_000;
const MIN_CHUNK_MS = 3_000;
const LINES_PER_CHUNK = 8; // well under the 30-line cap; keeps sections short for kids' songs

const BASE_STYLES = ["children's song", "gentle", "warm", "clear friendly vocals", "simple melody", "great production quality"];
const NEGATIVE_STYLES = ["aggressive", "distorted", "screaming", "explicit", "heavy drums", "dark", "scary"];

type MusicClient = Pick<ElevenLabsClient, "music">;

/** Splits lyrics into ≤8-line chunks whose durations sum exactly to lengthSec. Exported for tests. */
export function buildCompositionPlan(input: { lyrics: string[]; prompt: string; lengthSec: number }): ElevenLabs.CompositionPlan {
  const totalMs = input.lengthSec * 1000;
  const minChunks = Math.ceil(totalMs / MAX_CHUNK_MS);
  const maxChunks = Math.max(1, Math.floor(totalMs / MIN_CHUNK_MS));
  const n = Math.min(maxChunks, Math.max(minChunks, Math.ceil(input.lyrics.length / LINES_PER_CHUNK), 1));

  const perChunk = Math.floor(totalMs / n);
  const linesPer = Math.ceil(input.lyrics.length / n);
  const styles = [
    ...input.prompt.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 10),
    ...BASE_STYLES,
  ];

  const chunks: ElevenLabs.GenerationChunkInput[] = [];
  for (let i = 0; i < n; i++) {
    const lines = input.lyrics.slice(i * linesPer, (i + 1) * linesPer).map((l) => l.slice(0, 200));
    chunks.push({
      text: [`[Verse ${i + 1}]`, ...lines].join("\n"),
      durationMs: i === n - 1 ? totalMs - perChunk * (n - 1) : perChunk,
      positiveStyles: i === 0 ? styles : ["consistent with the previous section", ...BASE_STYLES.slice(0, 3)],
      negativeStyles: NEGATIVE_STYLES,
    });
  }
  return { chunks };
}

export class ElevenLabsMusicProvider implements MusicProvider {
  private readonly client: MusicClient;
  private readonly model: string;

  constructor(opts: { apiKey: string; model: string; client?: MusicClient }) {
    this.client = opts.client ?? new ElevenLabsClient({ apiKey: opts.apiKey, maxRetries: 0 });
    this.model = opts.model;
  }

  async compose(input: { lyrics: string[]; prompt: string; lengthSec: number }): Promise<Buffer> {
    return callVendor("elevenlabs", async () => {
      const stream = await this.client.music.compose(
        {
          compositionPlan: buildCompositionPlan(input),
          modelId: this.model as ElevenLabs.MusicModelId,
          outputFormat: "mp3_44100_192",
        },
        { timeoutInSeconds: TIMEOUT_SEC, maxRetries: 0 },
      );
      return readAll(stream);
    });
  }
}
