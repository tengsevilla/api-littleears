// Gemini ImageProvider — Interactions API (`ai.interactions.create`).
// Docs verified 2026-10-29:
//   https://ai.google.dev/gemini-api/docs/image-generation
//     Lists gemini-nano-banana-2.1 and shows only `ai.interactions.create({ model, input,
//     response_format: { type: "image", mime_type, aspect_ratio, image_size } })`;
//     result in `interaction.output_image.data` (base64).
//   https://ai.google.dev/gemini-api/docs/interactions
//     Interactions API is GA; generateContent "remains fully supported" but the
//     gemini-nano-banana-2.1 page documents only Interactions, so that is what we use.
//   SDK: @google/genai@2.32 typings (ImageResponseFormat { type: "image", aspect_ratio: "1:1", mime_type };
//     request options { timeout_ms, retries: { strategy: "none" } }; output_image: { data, mime_type }).
// Live check 2026-10-29: the API rejects mime_type "image/png" for this model
// ("Supported values: 'image/jpeg'"), so we request JPEG and re-encode to PNG with ffmpeg.
import { GoogleGenAI } from "@google/genai";
import { toPng } from "../../lib/ffmpeg.js";
import { ProviderError, callVendor } from "../errors.js";
import type { ImageProvider } from "../types.js";

const TIMEOUT_MS = 120_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

type InteractionsClient = Pick<GoogleGenAI, "interactions">;

export class GeminiImageProvider implements ImageProvider {
  private readonly client: InteractionsClient;
  private readonly model: string;

  constructor(opts: { apiKey: string; model: string; client?: InteractionsClient }) {
    this.client = opts.client ?? new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  async generate(input: { prompt: string }): Promise<Buffer> {
    const interaction = await callVendor("gemini", () =>
      this.client.interactions.create(
        {
          model: this.model,
          input: input.prompt,
          response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: "1:1", image_size: "1K" },
        },
        { timeout_ms: TIMEOUT_MS, retries: { strategy: "none" } },
      ),
    );
    const data = interaction.output_image?.data;
    // No image back = the model declined (safety filter) — retrying the same prompt won't help.
    if (!data) throw new ProviderError("gemini", "PROVIDER_REJECTED", false, "returned no image");
    const image = Buffer.from(data, "base64");
    if (image.subarray(0, 4).equals(PNG_MAGIC)) return image;
    if (!image.subarray(0, 3).equals(JPEG_MAGIC)) {
      throw new ProviderError("gemini", "PROVIDER_UNAVAILABLE", true, "returned an unrecognised image");
    }
    return toPng(image);
  }
}
