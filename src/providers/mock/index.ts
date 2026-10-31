// Mock providers (R5): deterministic fixtures, no network. Used when *_PROVIDER=mock.
// Force the safety-fail path with a topic containing "[unsafe]": write() carries the marker
// into the title and check() fails anything containing it.
// "[personal]" works the same way but only fails GENERIC songs (check without `personalized`):
// it stands for a person's name / real place / personal detail, which R1 forbids in songs that
// are shared with every family.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { LyricsDraftSchema } from "../lyricsRules.js";
import type { ImageProvider, LyricsDraft, LyricsProvider, MusicProvider, SafetyResult, TtsProvider } from "../types.js";

export const UNSAFE_MARKER = "[unsafe]";
export const PERSONAL_MARKER = "[personal]";

// src/providers/mock → api-littleears/fixtures (same depth under dist/).
const fixture = (name: string) => fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));

export class MockLyricsProvider implements LyricsProvider {
  async write(input: Parameters<LyricsProvider["write"]>[0]): Promise<LyricsDraft> {
    const draft = LyricsDraftSchema.parse(JSON.parse(await readFile(fixture("lyrics.json"), "utf8")));
    const name = input.childName ?? "little one";
    const topic = input.topic.toLowerCase();
    const markers = [UNSAFE_MARKER, PERSONAL_MARKER].filter((m) => topic.includes(m));
    return {
      ...draft,
      title: [draft.title, ...markers].join(" "),
      lyrics: draft.lyrics.map((l) => l.replaceAll("{name}", name)),
    };
  }

  async check(input: Parameters<LyricsProvider["check"]>[0]): Promise<SafetyResult> {
    const text = [input.title, ...input.lyrics, input.imagePrompt].join("\n").toLowerCase();
    const reasons: string[] = [];
    if (text.includes(UNSAFE_MARKER)) reasons.push("mock: unsafe marker present");
    if (!input.personalized && text.includes(PERSONAL_MARKER)) {
      reasons.push("rule 7: personal detail (a name, real place or personal detail) in a song shared with every family");
    }
    return { pass: reasons.length === 0, reasons };
  }
}

export class MockMusicProvider implements MusicProvider {
  async compose(): Promise<Buffer> {
    return readFile(fixture("tone.mp3"));
  }
}

export class MockImageProvider implements ImageProvider {
  async generate(): Promise<Buffer> {
    return readFile(fixture("cover.png"));
  }
}

export class MockTtsProvider implements TtsProvider {
  async speak(): Promise<Buffer> {
    return readFile(fixture("tone.mp3"));
  }
}
