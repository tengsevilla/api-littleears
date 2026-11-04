// Mock providers (R5): deterministic fixtures, no network. Used when *_PROVIDER=mock.
// Force the safety-fail path with a topic containing "[unsafe]": write() carries the marker
// into the title and check() fails anything containing it.
// "[personal]" works the same way but only fails GENERIC songs (check without `personalized`):
// it stands for a person's name / real place / personal detail, which R1 forbids in songs that
// are shared with every family.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runFfmpeg } from "../../lib/ffmpeg.js";
import { LyricsDraftSchema } from "../lyricsRules.js";
import type { DialogueLine, DialogueProvider, ImageProvider, LyricsDraft, LyricsProvider, MusicProvider, SafetyResult, SoundEffectsProvider, TtsProvider } from "../types.js";

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

/** Generates a quiet 220 Hz tone of the requested length (MP3 44.1 kHz stereo) with ffmpeg. */
export class MockSoundEffectsProvider implements SoundEffectsProvider {
  async generate(input: { durationSec: number }): Promise<Buffer> {
    return runFfmpeg(
      ["-f", "lavfi", "-i", `sine=frequency=220:sample_rate=44100:duration=${input.durationSec}`, "-af", "volume=0.3", "-ac", "2", "-codec:a", "libmp3lame", "-b:a", "192k", "-f", "mp3", "pipe:1"],
      Buffer.alloc(0),
    );
  }
}

/**
 * TTS-free dialogue stand-in: one tone per line (~70 ms per character, min 0.8 s), its pitch
 * picked from the voiceId so different speakers are audibly different. MP3 44.1 kHz mono.
 */
export class MockDialogueProvider implements DialogueProvider {
  async generate(input: { lines: DialogueLine[] }): Promise<Buffer> {
    const tones = input.lines.map((l) => {
      const freq = 300 + ([...l.voiceId].reduce((a, c) => a + c.charCodeAt(0), 0) % 8) * 60;
      const d = Math.max(0.8, l.text.length * 0.07).toFixed(2);
      return `sine=frequency=${freq}:sample_rate=44100:duration=${d}`;
    });
    const inputs = tones.flatMap((t) => ["-f", "lavfi", "-i", t]);
    const graph = `${tones.map((_, i) => `[${i}:a]`).join("")}concat=n=${tones.length}:v=0:a=1,volume=0.4[out]`;
    return runFfmpeg([...inputs, "-filter_complex", graph, "-map", "[out]", "-codec:a", "libmp3lame", "-b:a", "192k", "-f", "mp3", "pipe:1"], Buffer.alloc(0));
  }
}

export class MockTtsProvider implements TtsProvider {
  async speak(): Promise<Buffer> {
    return readFile(fixture("tone.mp3"));
  }
}
