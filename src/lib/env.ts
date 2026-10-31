import { z } from "zod";

// `KEY=` in a .env file yields "" — treat blank as unset so optional/default apply.
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const req = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema);
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

const DEFAULT_APP_URL = "http://localhost:3000";
// Resend's shared test sender: only delivers to the Resend account owner's address.
const DEFAULT_EMAIL_FROM = "LittleEars <onboarding@resend.dev>";
const emailProviderOf = (e: { EMAIL_PROVIDER?: "resend" | "mock" | undefined; RESEND_API_KEY?: string | undefined }) =>
  e.EMAIL_PROVIDER ?? (e.RESEND_API_KEY ? "resend" : "mock");

const EnvSchema = z
  .object({
    PORT: req(z.coerce.number().int().positive().default(3001)),
    NODE_ENV: req(z.enum(["development", "production", "test"]).default("development")),
    CORS_ORIGIN: req(z.url()),
    // Frontend origin used in invite links. Defaults to localhost outside production.
    APP_URL: opt(z.url()),

    DB_HOST: req(z.string()),
    DB_PORT: req(z.coerce.number().int().positive().default(3306)),
    DB_USER: req(z.string()),
    DB_PASSWORD: z.string().default(""),
    DB_NAME: req(z.string()),

    JWT_SECRET: req(z.string().min(32)),
    JWT_REFRESH_SECRET: req(z.string().min(32)),

    // Only the seed script requires these (it checks them itself).
    SEED_USER_EMAIL: opt(z.email()),
    SEED_USER_PASSWORD: opt(z.string().min(8)),

    LYRICS_PROVIDER: req(z.enum(["openai", "mock"])),
    OPENAI_API_KEY: opt(z.string()),
    OPENAI_MODEL: opt(z.string()),

    MUSIC_PROVIDER: req(z.enum(["elevenlabs", "mock"])),
    ELEVENLABS_API_KEY: opt(z.string()),
    ELEVENLABS_MUSIC_MODEL: opt(z.string()),
    ELEVENLABS_TTS_MODEL: opt(z.string()),
    ELEVENLABS_TTS_VOICE_ID: opt(z.string()),

    IMAGE_PROVIDER: req(z.enum(["gemini", "mock"])),
    GEMINI_API_KEY: opt(z.string()),
    GEMINI_IMAGE_MODEL: opt(z.string()),

    S3_BUCKET: req(z.string().trim()), // trim: a stray trailing space in .env breaks every S3 call
    S3_REGION: req(z.string()),
    S3_ENDPOINT: opt(z.url()), // only for R2 / S3-compatible stores
    AWS_ACCESS_KEY_ID: req(z.string()),
    AWS_SECRET_ACCESS_KEY: req(z.string()),

    // Invite emails. EMAIL_PROVIDER defaults to resend when RESEND_API_KEY is set, else mock.
    RESEND_API_KEY: opt(z.string()),
    EMAIL_PROVIDER: opt(z.enum(["resend", "mock"])),
    EMAIL_FROM: req(z.string().trim().min(3).default(DEFAULT_EMAIL_FROM)),

    WORKER_POLL_MS: req(z.coerce.number().int().positive().default(2000)),
    WORKER_MAX_ATTEMPTS: req(z.coerce.number().int().positive().default(3)),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.APP_URL) {
      ctx.addIssue({ code: "custom", path: ["APP_URL"], message: "Required in production" });
    }
    const emailProvider = emailProviderOf(env);
    if (env.NODE_ENV === "production" && emailProvider !== "resend") {
      ctx.addIssue({ code: "custom", path: ["EMAIL_PROVIDER"], message: 'Must be "resend" in production' });
    }
    if (emailProvider === "resend" && !env.RESEND_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["RESEND_API_KEY"], message: 'Required when provider is "resend"' });
    }
    // Vendor keys/model IDs are required only when that provider is live (not mock).
    const required: Record<string, (keyof typeof env)[]> = {
      openai: ["OPENAI_API_KEY", "OPENAI_MODEL"],
      elevenlabs: [
        "ELEVENLABS_API_KEY",
        "ELEVENLABS_MUSIC_MODEL",
        "ELEVENLABS_TTS_MODEL",
        "ELEVENLABS_TTS_VOICE_ID",
      ],
      gemini: ["GEMINI_API_KEY", "GEMINI_IMAGE_MODEL"],
    };
    for (const provider of [env.LYRICS_PROVIDER, env.MUSIC_PROVIDER, env.IMAGE_PROVIDER]) {
      for (const key of required[provider] ?? []) {
        if (!env[key]) {
          ctx.addIssue({ code: "custom", path: [key], message: `Required when provider is "${provider}"` });
        }
      }
    }
  })
  .transform((env) => ({
    ...env,
    APP_URL: (env.APP_URL ?? DEFAULT_APP_URL).replace(/\/+$/, ""),
    EMAIL_PROVIDER: emailProviderOf(env),
  }));

export type Env = z.infer<typeof EnvSchema>;

/** Validates an env source (exported for tests); throws with key names only, never values. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Messages name keys and rules only — never values.
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export const env = parseEnv(process.env);
