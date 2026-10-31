// Vendor-neutral lyrics + safety rules (R1). System prompts, output schemas and parsers live
// here so any LyricsProvider (OpenAI now, others later) enforces the same rules.
import { z } from "zod";
import type { AgeBand, LyricsDraft, Mood, SafetyResult } from "./types.js";

/** R1 length caps: 60 s for ages 1–2, 120 s for ages 3–5. */
export const MAX_LENGTH_SEC: Record<AgeBand, number> = { "1-2": 60, "3-5": 120 };

export function effectiveLengthSec(ageBand: AgeBand, lengthSec: number): number {
  return Math.min(lengthSec, MAX_LENGTH_SEC[ageBand]);
}

/** Rough sung-line budget: ~4 s per short line for toddlers, ~5 s for preschoolers. */
export function lineBudget(ageBand: AgeBand, lengthSec: number): { min: number; max: number } {
  const perLine = ageBand === "1-2" ? 4 : 5;
  const target = Math.round(effectiveLengthSec(ageBand, lengthSec) / perLine);
  return { min: Math.max(4, target - 4), max: Math.min(40, target + 2) };
}

const CONTENT_RULES = `
CONTENT RULES (all mandatory):
1. Original lyrics only. Never reproduce, quote, parody or adapt existing songs or nursery rhymes, and never mention named characters, brands, franchises, shows or celebrities.
2. No fear, danger, violence, villains, monsters, death, loss, getting lost, punishment, scolding, or body shaming (no comments on size, weight or looks).
3. Never model unsafe behavior: no climbing high, jumping off things, touching hot things or fire, putting objects in the mouth, wandering off, going near water or roads alone, or playing with sharp objects.
4. No food or medicine claims and no instructions to eat or drink specific things (no "eat this to grow strong", no medicine, no vitamins).
5. Lullaby mood: slow, soft, calm, sleep imagery only (moon, stars, blankets, soft breathing, quiet animals resting). No excitement, no loud sounds, no action.
6. The image prompt describes only animals, objects, nature or a cute cartoon mascot. It must never describe a human child, a real person, or include any person's name, and it must contain no text, letters or logos.`.trim();

const AGE_RULES: Record<AgeBand, string> = {
  "1-2": "AGES 1-2: very simple, concrete words (one or two syllables), heavy repetition, very short lines (3-6 words), a single simple idea, maximum 60 seconds.",
  "3-5": "AGES 3-5: simple vocabulary, a gentle little story with a happy ending, a repeated chorus, short lines (4-9 words), maximum 120 seconds.",
};

const MOOD_RULES: Record<Mood, string> = {
  playful: "MOOD playful: bright, bouncy, cheerful, gentle fun.",
  calm: "MOOD calm: gentle, warm, unhurried, soothing.",
  lullaby: "MOOD lullaby: slow, soft, hushed, sleep imagery only.",
};

export function writeSystemPrompt(ageBand: AgeBand, mood: Mood): string {
  return `You write short, original songs for babies and young children for the LittleEars app.

${AGE_RULES[ageBand]}
${MOOD_RULES[mood]}

${CONTENT_RULES}

NAME: if a child's name is given, use it warmly 1-3 times in the lyrics, spelled exactly as given (it is written phonetically for a singing voice). Never put the name in the title or the image prompt.

OUTPUT: JSON only, matching the schema.
- title: 2-6 words, no child name.
- lyrics: one sung line per array item, no section labels, no stage directions, no emojis.
- musicPrompt: comma-separated musical styles for a music model (genre, instruments, tempo in bpm, vocal style). Gentle, child-friendly; never name real artists or songs.
- imagePrompt: one sentence describing a single cover scene of animals/objects/a cartoon mascot (see rule 6). No style words; the app adds its own art style.`;
}

export function writeUserPrompt(input: {
  topic: string;
  lengthSec: number;
  ageBand: AgeBand;
  childName?: string;
  feedback?: string[];
}): string {
  const sec = effectiveLengthSec(input.ageBand, input.lengthSec);
  const { min, max } = lineBudget(input.ageBand, input.lengthSec);
  const lines = [
    `Topic: ${input.topic}`,
    `Song length: about ${sec} seconds (${min}-${max} lyric lines).`,
    input.childName
      ? `Child's name: ${input.childName}`
      : "No child's name: write a generic song for any child. It will be shared with other families, so use no person's name, no real place (city, school, street, venue) and no personal detail anywhere.",
  ];
  if (input.feedback?.length) {
    // Safety-check reasons from the previous draft (R1 regeneration loop).
    lines.push(
      "",
      "A previous draft for this topic FAILED the independent safety review for these reasons.",
      "Write a completely new draft (title, lyrics, music prompt and image prompt) that fixes every one of them while following all rules:",
      ...input.feedback.map((r) => `- ${r}`),
    );
  }
  return lines.join("\n");
}

const MOOD_CHECK: Record<Mood, string> = {
  lullaby:
    "This song's mood is LULLABY: apply rule 5 strictly. It fails if it contains excitement, loud sounds, fast action or anything that is not slow, soft and sleepy.",
  playful:
    "This song's mood is PLAYFUL (a daytime song, not a lullaby): rule 5 does not apply. Never fail it for being lively or for lacking sleep imagery.",
  calm: "This song's mood is CALM (a daytime song, not a lullaby): rule 5 does not apply. Never fail it for lacking sleep imagery.",
};

/**
 * R1: a generic song is shared with every family once approved, so it may carry no personal
 * detail at all — not even a first name.
 */
const GENERIC_CHECK = `This is a GENERIC song (no child's name): once approved it is shared with every family in the app. Rule 7 applies:
7. The title, lyrics and image prompt must contain no person's name (not even a first name), no specific real place (city, town, school, street, park, venue, address) and no other personal detail (birthdays, ages of specific people, family members' names, pets' names, workplaces). Generic words like "mommy", "grandpa", "the park" or "the beach" are fine. If any is present, fail with a reason starting "rule 7: personal detail".`;

/**
 * The reviewer is told the mood, so the lullaby rule (5) applies only when mood is lullaby.
 * `personalized` = the song is for one family's child; otherwise the generic-song rule 7 applies.
 */
export function safetySystemPrompt(mood: Mood, personalized = false): string {
  return `You are the independent safety reviewer for LittleEars, an app that plays songs to children aged 1-5. You did not write the content you review. Be strict: when in doubt, fail.

Check the title, the lyrics and the image prompt against every rule below and the age band given.

${AGE_RULES["1-2"]}
${AGE_RULES["3-5"]}
Content must suit the given age band (vocabulary, line length, simplicity).

${CONTENT_RULES}

${MOOD_CHECK[mood]}
${personalized ? "" : `\n${GENERIC_CHECK}\n`}
Also fail for: anything scary, sad, mean or confusing for a small child; adult themes; insults; unsafe advice of any kind; personal data beyond a first name (last names, birthdays, schools, places, addresses); an image prompt that depicts a human child or contains a name.

OUTPUT: JSON only, matching the schema: {"pass": boolean, "reasons": string[]}.
- pass = true only if every rule is met; then reasons is [].
- pass = false otherwise; reasons lists each violated rule briefly (e.g. "rule 3: models climbing high").`;
}

export function checkUserPrompt(input: { title: string; lyrics: string[]; imagePrompt: string; ageBand: AgeBand; mood: Mood }): string {
  return JSON.stringify({ ageBand: input.ageBand, mood: input.mood, title: input.title, lyrics: input.lyrics, imagePrompt: input.imagePrompt });
}

// --- Output schemas ------------------------------------------------------------------------

export const LyricsDraftSchema = z.object({
  title: z.string().trim().min(1).max(120),
  lyrics: z.array(z.string().trim().min(1).max(200)).min(2).max(60),
  musicPrompt: z.string().trim().min(1).max(1000),
  imagePrompt: z.string().trim().min(1).max(1000),
});

export const SafetyResultSchema = z.object({
  pass: z.boolean(),
  reasons: z.array(z.string()),
});

/** JSON Schema twins of the Zod schemas, for vendors' strict structured-output modes. */
export const LYRICS_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    lyrics: { type: "array", items: { type: "string" } },
    musicPrompt: { type: "string" },
    imagePrompt: { type: "string" },
  },
  required: ["title", "lyrics", "musicPrompt", "imagePrompt"],
  additionalProperties: false,
} as const;

export const SAFETY_JSON_SCHEMA = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["pass", "reasons"],
  additionalProperties: false,
} as const;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** null = the model's output is unusable (invalid JSON, wrong shape, or a name leaked into the image prompt). */
export function parseLyricsDraft(text: string, childName?: string): LyricsDraft | null {
  const parsed = LyricsDraftSchema.safeParse(parseJson(text));
  if (!parsed.success) return null;
  if (childName && mentionsName(parsed.data.imagePrompt + " " + parsed.data.title, childName)) return null;
  return parsed.data;
}

export const INVALID_SAFETY_RESPONSE: SafetyResult = { pass: false, reasons: ["invalid safety response"] };

/** Invalid JSON or shape counts as a fail (R1). A "pass" with reasons is contradictory → fail. */
export function parseSafetyResult(text: string): SafetyResult {
  const parsed = SafetyResultSchema.safeParse(parseJson(text));
  if (!parsed.success) return INVALID_SAFETY_RESPONSE;
  const { pass, reasons } = parsed.data;
  if (!pass && reasons.length === 0) return { pass: false, reasons: ["unspecified safety failure"] };
  if (pass && reasons.length > 0) return { pass: false, reasons };
  return { pass, reasons };
}

/** True when any word (2+ letters) of `name` appears as a whole word in `text` (R4 image-prompt guard). */
export function mentionsName(text: string, name: string): boolean {
  const words = name.toLowerCase().split(/[\s-]+/).filter((w) => w.length >= 2);
  const haystack = ` ${text.toLowerCase().replace(/[^\p{L}\p{M}]+/gu, " ")} `;
  return words.some((w) => haystack.includes(` ${w} `));
}
