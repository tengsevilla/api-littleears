import type { ImageProvider } from "./types.js";

// PROJECT.md §10 — fixed LittleEars art style, prepended to every image prompt.
export const STYLE_PROMPT =
  "Soft, rounded children's picture-book illustration. Flat pastel colors, thick friendly outlines, simple shapes, gentle lighting, plain background. Cute animal or object characters with big eyes. No text, no letters, no logos, no real people, no existing cartoon characters. Square composition.";

/** Wraps any ImageProvider so every prompt carries STYLE_PROMPT. The registry always applies it. */
export class StyledImageProvider implements ImageProvider {
  constructor(readonly inner: ImageProvider) {}

  generate({ prompt }: { prompt: string }): Promise<Buffer> {
    return this.inner.generate({ prompt: `${STYLE_PROMPT}\n\n${prompt}` });
  }
}
