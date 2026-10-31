// Provider interfaces — PROJECT.md §8. Route and worker code depend only on these;
// vendor SDKs are imported only inside src/providers/<vendor>/ (R5).

export type AgeBand = "1-2" | "3-5";
export type Mood = "playful" | "calm" | "lullaby";

export type LyricsDraft = { title: string; lyrics: string[]; musicPrompt: string; imagePrompt: string };
export type SafetyResult = { pass: boolean; reasons: string[] };

export interface LyricsProvider {
  /** `feedback`: reasons a previous draft failed the safety check; the new draft must fix them. */
  write(input: {
    topic: string;
    mood: Mood;
    ageBand: AgeBand;
    lengthSec: number;
    childName?: string;
    feedback?: string[];
  }): Promise<LyricsDraft>;
  /**
   * `personalized`: the song is for one family's child (has a childName). Omitted/false = generic:
   * shared with every family once approved, so the stricter no-personal-detail rule applies (R1).
   */
  check(input: {
    title: string;
    lyrics: string[];
    imagePrompt: string;
    ageBand: AgeBand;
    mood: Mood;
    personalized?: boolean;
  }): Promise<SafetyResult>;
}

export interface MusicProvider {
  compose(input: { lyrics: string[]; prompt: string; lengthSec: number }): Promise<Buffer>;
}

export interface ImageProvider {
  generate(input: { prompt: string }): Promise<Buffer>; // PNG, square
}

export interface TtsProvider {
  speak(input: { text: string }): Promise<Buffer>; // MP3
}

export type Providers = {
  lyrics: LyricsProvider;
  music: MusicProvider;
  image: ImageProvider;
  tts: TtsProvider;
};
