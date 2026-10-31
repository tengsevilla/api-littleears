// Runs one claimed job through the generation pipeline (PROJECT.md §5):
//   writing → checking → composing → illustrating → mixing → pending_review
// Nothing here ever sets `ready` — only a parent's approve does (R1).
import { env } from "../lib/env.js";
import { FADE_OUT_SEC, SLEEP_FADE_OUT_SEC, masterAudio } from "../lib/ffmpeg.js";
import { deleteObjects, getObjectBuffer, putObject, storageErrorStatus } from "../lib/storage.js";
import * as ChildrenModel from "../models/children.model.js";
import * as JobsModel from "../models/jobs.model.js";
import type { Job, SongPatch, Step, WorkSong } from "../models/jobs.model.js";
import type { RegenPart } from "../models/songs.model.js";
import { getProviders } from "../providers/index.js";
import { ProviderError } from "../providers/errors.js";
import { effectiveLengthSec, mentionsName } from "../providers/lyricsRules.js";

/** R1: a draft that fails the safety check is rewritten at most this many times, then rejected. */
export const MAX_SAFETY_REGENS = 2;

/** Steps a regenerate job re-runs even though their output exists (checking re-runs on its own: writing clears it). */
const FORCED: Record<RegenPart, readonly Step[]> = {
  lyrics: ["writing", "composing", "mixing"],
  music: ["composing", "mixing"],
  image: ["illustrating"],
};

/** A pipeline invariant broke (not a provider error). Non-transient unless stated. */
export class PipelineError extends Error {
  constructor(
    message: string,
    readonly transient = false,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

type StepResult =
  | { kind: "next"; patch: SongPatch; newKey?: string; oldKey?: string | null }
  | { kind: "rewrite"; patch: SongPatch } // safety check failed: write again with its reasons
  | { kind: "rejected"; patch: SongPatch }; // safety check failed after MAX_SAFETY_REGENS rewrites

type Ctx = { job: Job; song: WorkSong; safetyRegens: number };

const nextStep = (step: Step): Step | null => JobsModel.STEPS[JobsModel.STEPS.indexOf(step) + 1] ?? null;

/** Idempotency: a step whose output already exists is skipped (unless a regenerate forces it). */
function isDone(step: Step, s: WorkSong): boolean {
  switch (step) {
    case "writing":
      return s.lyrics !== null && s.safety?.pass !== false; // failed check → rewrite
    case "checking":
      return s.safety?.pass === true;
    case "composing":
      return s.rawAudioKey !== null;
    case "illustrating":
      return s.imageKey !== null;
    case "mixing":
      return s.audioKey !== null;
  }
}

function need<T>(value: T | null, what: string): T {
  if (value === null) throw new PipelineError(`${what} missing`);
  return value;
}

/** Unique per generation, so the media URL's `v` changes and old objects can be deleted. */
const mediaKey = (s: WorkSong, name: "raw" | "audio" | "image", ext: "mp3" | "png") =>
  `songs/${s.userId}/${s.id}/${name}-${Date.now()}.${ext}`;

/** Names that must never reach an image prompt (R4): display and phonetic spellings. */
async function childNames(s: WorkSong): Promise<{ spoken: string; all: string[] } | null> {
  if (!s.childId) return null;
  const child = await ChildrenModel.findNamesById(s.childId);
  if (!child) throw new PipelineError("child missing for personalized song");
  return {
    spoken: child.phoneticName ?? child.displayName, // R2
    all: [child.displayName, child.phoneticName].filter((n): n is string => !!n),
  };
}

const STEP_RUNNERS: Record<Step, (ctx: Ctx) => Promise<StepResult>> = {
  async writing({ song }) {
    const names = await childNames(song);
    const feedback = song.safety?.pass === false ? song.safety.reasons : undefined;
    const draft = await getProviders().lyrics.write({
      topic: song.topic,
      mood: song.mood,
      ageBand: song.ageBand,
      lengthSec: song.lengthSec,
      ...(names ? { childName: names.spoken } : {}),
      ...(feedback ? { feedback } : {}),
    });
    // R4: the image prompt (and title) never carry the child's name. A leak is a model hiccup → retry.
    if (names?.all.some((n) => mentionsName(`${draft.imagePrompt} ${draft.title}`, n))) {
      throw new PipelineError("draft put the child's name in the title or image prompt", true);
    }
    return {
      kind: "next",
      patch: {
        title: draft.title,
        lyrics: draft.lyrics,
        musicPrompt: draft.musicPrompt,
        // A regenerated-lyrics song keeps its cover, so keep the prompt that cover was made from.
        imagePrompt: song.imageKey && song.imagePrompt ? song.imagePrompt : draft.imagePrompt,
        safety: null,
      },
    };
  },

  async checking({ song, safetyRegens }) {
    const result = await getProviders().lyrics.check({
      title: need(song.title, "title"),
      lyrics: need(song.lyrics, "lyrics"),
      imagePrompt: need(song.imagePrompt, "image prompt"),
      ageBand: song.ageBand,
      mood: song.mood,
      personalized: song.childId !== null, // generic songs get the stricter no-personal-detail rule (R1)
    });
    if (result.pass) return { kind: "next", patch: { safety: result } };
    if (safetyRegens < MAX_SAFETY_REGENS) return { kind: "rewrite", patch: { safety: result } };
    return { kind: "rejected", patch: { safety: result, status: "rejected" } };
  },

  async composing({ song }) {
    const audio = await getProviders().music.compose({
      lyrics: need(song.lyrics, "lyrics"),
      prompt: need(song.musicPrompt, "music prompt"),
      lengthSec: effectiveLengthSec(song.ageBand, song.lengthSec),
    });
    const key = mediaKey(song, "raw", "mp3");
    await putObject(key, audio, "audio/mpeg");
    return { kind: "next", patch: { rawAudioKey: key }, newKey: key, oldKey: song.rawAudioKey };
  },

  async illustrating({ song }) {
    const prompt = need(song.imagePrompt, "image prompt");
    const names = await childNames(song);
    // R4 last line of defence: never send a child's name to the image model.
    if (names?.all.some((n) => mentionsName(prompt, n))) throw new PipelineError("image prompt contains the child's name");
    const image = await getProviders().image.generate({ prompt });
    const key = mediaKey(song, "image", "png");
    await putObject(key, image, "image/png");
    return { kind: "next", patch: { imageKey: key }, newKey: key, oldKey: song.imageKey };
  },

  async mixing({ song }) {
    const raw = await getObjectBuffer(need(song.rawAudioKey, "raw audio"));
    const fadeOut = song.mood === "lullaby" ? SLEEP_FADE_OUT_SEC : FADE_OUT_SEC;
    const { audio, durationMs } = await masterAudio(raw, fadeOut); // R3
    const key = mediaKey(song, "audio", "mp3");
    await putObject(key, audio, "audio/mpeg");
    return { kind: "next", patch: { audioKey: key, durationMs }, newKey: key, oldKey: song.audioKey };
  },
};

/** Old/orphaned objects: best effort — a leftover object is harmless, a failed song is not. */
async function deleteQuietly(keys: string[]): Promise<void> {
  try {
    await deleteObjects(keys);
  } catch (err) {
    console.warn(`[worker] could not delete ${keys.length} superseded object(s): ${err instanceof Error ? err.name : "error"}`);
  }
}

const backoffSec = (attempts: number) => 2 ** attempts * 5;

/** Generic, name-free text for songs.error (shown to the parent). */
function userMessage(err: unknown): string {
  if (err instanceof ProviderError) {
    if (err.code === "PROVIDER_QUOTA") return "The generation service is busy or out of quota. Please try again later.";
    if (err.code === "PROVIDER_REJECTED") return "The generation service declined this song. Try a different topic.";
    return "The generation service is unavailable right now. Please try again later.";
  }
  return "Something went wrong while making this song. Please try again.";
}

/** Internal detail for jobs.last_error. Provider/pipeline messages are name-free by design. */
function errorDetail(step: Step, err: unknown): string {
  const code = err instanceof ProviderError ? err.code : err instanceof Error ? err.name : "Error";
  const message = err instanceof Error ? err.message : String(err);
  return `${step}: ${code}: ${message}`.slice(0, 1000);
}

function isTransient(err: unknown): boolean {
  if (err instanceof ProviderError || err instanceof PipelineError) return err.transient;
  // S3 4xx (AccessDenied, NoSuchKey, ...) is configuration or data, not a blip; 429 is throttling.
  const status = storageErrorStatus(err);
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) return false;
  return true; // S3 5xx / ffmpeg / network blips
}

async function handleFailure(ctx: Ctx, step: Step, attempts: number, err: unknown): Promise<void> {
  const nextAttempts = attempts + 1;
  const detail = errorDetail(step, err);
  if (isTransient(err) && nextAttempts < env.WORKER_MAX_ATTEMPTS) {
    const delay = backoffSec(nextAttempts);
    console.warn(`[worker] song ${ctx.song.id} ${step} failed (attempt ${nextAttempts}), retrying in ${delay}s`);
    await JobsModel.scheduleRetry(ctx.job.id, nextAttempts, delay, detail);
    return;
  }
  console.warn(`[worker] song ${ctx.song.id} ${step} failed permanently after ${nextAttempts} attempt(s)`);
  await JobsModel.finishJob(ctx.job.id, ctx.song.id, { status: "failed", error: userMessage(err) }, nextAttempts, detail);
}

export async function runJob(job: Job): Promise<void> {
  let attempts = job.attempts;
  let safetyRegens = job.safetyRegens;

  for (let step: Step | null = job.step; step !== null; ) {
    const song = await JobsModel.findWorkSong(job.songId);
    if (!song) return; // deleted mid-run; its jobs cascaded away
    const forced = job.regenPart !== null && FORCED[job.regenPart].includes(step);
    if (!forced && isDone(step, song)) {
      step = nextStep(step);
      continue;
    }

    await JobsModel.startStep(job.id, song.id, step);
    const ctx: Ctx = { job, song, safetyRegens };
    let result: StepResult;
    try {
      result = await STEP_RUNNERS[step](ctx);
    } catch (err) {
      await handleFailure(ctx, step, attempts, err);
      return;
    }

    if (result.kind === "rejected") {
      console.info(`[worker] song ${song.id} rejected by the safety check after ${safetyRegens} rewrite(s)`);
      await JobsModel.finishJob(job.id, song.id, result.patch, 0, null);
      return;
    }
    const target: Step = result.kind === "rewrite" ? "writing" : (nextStep(step) ?? step);
    if (result.kind === "rewrite") safetyRegens += 1;
    const saved = await JobsModel.completeStep(job.id, song.id, result.patch, target, safetyRegens);
    if (result.kind === "next") {
      if (!saved) {
        if (result.newKey) await deleteQuietly([result.newKey]); // song deleted meanwhile
        return;
      }
      if (result.oldKey && result.oldKey !== result.newKey) await deleteQuietly([result.oldKey]); // superseded
    }
    attempts = 0;
    step = result.kind === "rewrite" ? "writing" : nextStep(step);
  }

  await JobsModel.finishJob(job.id, job.songId, { status: "pending_review", error: null }, 0, null);
  console.info(`[worker] song ${job.songId} ready for parent review`);
}
