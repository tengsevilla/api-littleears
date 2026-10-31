// Provider registry: picks implementations from LYRICS_PROVIDER / MUSIC_PROVIDER / IMAGE_PROVIDER.
// TTS follows MUSIC_PROVIDER (both ElevenLabs). Invite email: EMAIL_PROVIDER (getEmailProvider). Callers use getProviders() and the interfaces in
// ./types — never a vendor SDK.
import { env, type Env } from "../lib/env.js";
import { MockEmailProvider } from "./email/mock.js";
import { ResendEmailProvider } from "./email/resend.js";
import type { EmailProvider } from "./email/types.js";
import { ElevenLabsMusicProvider } from "./elevenlabs/music.js";
import { ElevenLabsTtsProvider } from "./elevenlabs/tts.js";
import { GeminiImageProvider } from "./gemini/image.js";
import { StyledImageProvider } from "./image.js";
import { MockImageProvider, MockLyricsProvider, MockMusicProvider, MockTtsProvider } from "./mock/index.js";
import { OpenAiLyricsProvider } from "./openai/lyrics.js";
import type { Providers } from "./types.js";

export type ProviderConfig = Pick<
  Env,
  | "LYRICS_PROVIDER"
  | "OPENAI_API_KEY"
  | "OPENAI_MODEL"
  | "MUSIC_PROVIDER"
  | "ELEVENLABS_API_KEY"
  | "ELEVENLABS_MUSIC_MODEL"
  | "ELEVENLABS_TTS_MODEL"
  | "ELEVENLABS_TTS_VOICE_ID"
  | "IMAGE_PROVIDER"
  | "GEMINI_API_KEY"
  | "GEMINI_IMAGE_MODEL"
>;

function need(value: string | undefined, key: string): string {
  // lib/env.ts already enforces these for live providers; this guards direct callers.
  if (!value) throw new Error(`${key} is required for the selected provider`);
  return value;
}

export function createProviders(c: ProviderConfig): Providers {
  const lyrics =
    c.LYRICS_PROVIDER === "openai"
      ? new OpenAiLyricsProvider({ apiKey: need(c.OPENAI_API_KEY, "OPENAI_API_KEY"), model: need(c.OPENAI_MODEL, "OPENAI_MODEL") })
      : new MockLyricsProvider();

  const eleven = c.MUSIC_PROVIDER === "elevenlabs";
  const music = eleven
    ? new ElevenLabsMusicProvider({
        apiKey: need(c.ELEVENLABS_API_KEY, "ELEVENLABS_API_KEY"),
        model: need(c.ELEVENLABS_MUSIC_MODEL, "ELEVENLABS_MUSIC_MODEL"),
      })
    : new MockMusicProvider();
  const tts = eleven
    ? new ElevenLabsTtsProvider({
        apiKey: need(c.ELEVENLABS_API_KEY, "ELEVENLABS_API_KEY"),
        model: need(c.ELEVENLABS_TTS_MODEL, "ELEVENLABS_TTS_MODEL"),
        voiceId: need(c.ELEVENLABS_TTS_VOICE_ID, "ELEVENLABS_TTS_VOICE_ID"),
      })
    : new MockTtsProvider();

  const image =
    c.IMAGE_PROVIDER === "gemini"
      ? new GeminiImageProvider({ apiKey: need(c.GEMINI_API_KEY, "GEMINI_API_KEY"), model: need(c.GEMINI_IMAGE_MODEL, "GEMINI_IMAGE_MODEL") })
      : new MockImageProvider();

  return { lyrics, music, tts, image: new StyledImageProvider(image) };
}

let cached: Providers | undefined;

/** Process-wide providers built from the validated env, created on first use. */
export function getProviders(): Providers {
  cached ??= createProviders(env);
  return cached;
}

export type EmailConfig = Pick<Env, "EMAIL_PROVIDER" | "RESEND_API_KEY" | "EMAIL_FROM">;

export function createEmailProvider(c: EmailConfig): EmailProvider {
  return c.EMAIL_PROVIDER === "resend"
    ? new ResendEmailProvider({ apiKey: need(c.RESEND_API_KEY, "RESEND_API_KEY"), from: c.EMAIL_FROM })
    : new MockEmailProvider();
}

let cachedEmail: EmailProvider | undefined;

/** Process-wide EmailProvider (EMAIL_PROVIDER), created on first use. */
export function getEmailProvider(): EmailProvider {
  cachedEmail ??= createEmailProvider(env);
  return cachedEmail;
}

export type { Providers } from "./types.js";
export type { EmailMessage, EmailProvider } from "./email/types.js";
