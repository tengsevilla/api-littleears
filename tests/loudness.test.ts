// R3: real ffmpeg, no network or providers. Signals are synthesized via lavfi, mastered by the
// production masterAudio() (the worker's mixing step), then measured in a separate ffmpeg pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FADE_OUT_SEC, SLEEP_FADE_OUT_SEC, masterAudio, masterFilter, measureLoudness, runFfmpeg } from "../src/lib/ffmpeg.js";

const TARGET_LUFS = -16;
const LU_TOLERANCE = 1; // PROJECT.md §12
// The chain limits to TP −1.5 and the spec ceiling is −1.0 dBTP, but MP3 encoding re-introduces
// inter-sample overshoot when the decoder reconstructs the waveform, so allow 0.5 dB of codec slack.
const MAX_TRUE_PEAK_DB = -0.5;

/** Slow swell between ~35% and 100% level — gives the signal music-like dynamics (non-zero LRA). */
const SWELL = "volume='0.35+0.65*abs(sin(0.4*t))':eval=frame";

const CASES = [
  // label, lavfi source, seconds, fade-out, expected input loudness (LUFS)
  ["quiet pink noise", `anoisesrc=color=pink:amplitude=0.25:seed=1,${SWELL}`, 40, FADE_OUT_SEC, -30],
  ["loud limited pink noise", `anoisesrc=color=pink:amplitude=1:seed=2,${SWELL},volume=9,alimiter=limit=0.95:level=false`, 40, FADE_OUT_SEC, -8],
  [
    "quiet lullaby chord (6 s sleep fade)",
    "aevalsrc='0.25*(0.1+0.5*abs(sin(0.3*t)))*(sin(2*PI*220*t)+0.5*sin(2*PI*330*t)+0.3*sin(2*PI*440*t))/1.8':s=44100",
    45,
    SLEEP_FADE_OUT_SEC,
    -27,
  ],
] as const;

/** Provider-like raw input: 44.1 kHz stereo MP3. */
function synth(source: string, seconds: number): Promise<Buffer> {
  return runFfmpeg(
    ["-f", "lavfi", "-i", source, "-t", String(seconds), "-ar", "44100", "-ac", "2", "-codec:a", "libmp3lame", "-b:a", "192k", "-f", "mp3", "pipe:1"],
    Buffer.alloc(0),
  );
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "littleears-loudness-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("R3 master chain", () => {
  it("uses the exact filter chain (2 s fade-out; 6 s sleep fade for lullabies)", () => {
    expect(masterFilter(60)).toBe("afade=t=in:d=1,loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=out:st=58:d=2");
    expect(masterFilter(90.5, SLEEP_FADE_OUT_SEC)).toBe("afade=t=in:d=1,loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=out:st=84.5:d=6");
    expect(masterFilter(1.5, FADE_OUT_SEC)).toBe("afade=t=in:d=1,loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=out:st=0:d=1.5");
  });

  it.each(CASES)("masters %s to −16 LUFS ±1, TP ≤ −0.5 dBTP, 44.1 kHz / 192 kbps", async (label, source, seconds, fade, expectedInput) => {
    const raw = await synth(source, seconds);
    const before = await measureLoudness(raw);
    const { audio, durationMs } = await masterAudio(raw, fade);
    const file = join(dir, `${label.replace(/\W+/g, "-")}.mp3`);
    await writeFile(file, audio);
    const after = await measureLoudness(audio);
    console.log(
      `[loudness] ${label} (${seconds} s, fade ${fade} s): in ${before.integratedLufs} LUFS / TP ${before.truePeakDb} → ` +
        `out ${after.integratedLufs} LUFS / TP ${after.truePeakDb} dBTP / LRA ${after.lra} LU, ${after.sampleRateHz} Hz ${after.bitrateKbps} kb/s, ${after.durationSec} s`,
    );

    // The fixture really is quiet / loud, so the chain had real work to do.
    expect(Math.abs(before.integratedLufs - expectedInput)).toBeLessThanOrEqual(3);

    expect(Math.abs(after.integratedLufs - TARGET_LUFS)).toBeLessThanOrEqual(LU_TOLERANCE);
    expect(after.truePeakDb).toBeLessThanOrEqual(MAX_TRUE_PEAK_DB);
    expect(after.sampleRateHz).toBe(44100);
    expect(after.bitrateKbps).toBe(192);
    // Header says 192; the file's average rate agrees (CBR), within ID3/padding overhead.
    const avgKbps = ((await stat(file)).size * 8) / after.durationSec / 1000;
    expect(Math.abs(avgKbps - 192)).toBeLessThan(192 * 0.03);
    expect(Math.abs(after.durationSec - seconds)).toBeLessThan(0.5);
    expect(durationMs).toBe(Math.round(after.durationSec * 1000));
  }, 120_000);

  it("audio:measure CLI prints the JSON report for a local file", async () => {
    const file = join(dir, "cli.mp3");
    await writeFile(file, (await masterAudio(await synth(CASES[0][1], 30))).audio);
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/scripts/measureLoudness.ts", file]);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(report).sort()).toEqual(["durationSec", "integratedLufs", "lra", "truePeakDb"]);
    expect(Math.abs((report.integratedLufs as number) - TARGET_LUFS)).toBeLessThanOrEqual(LU_TOLERANCE);
    expect(report.durationSec as number).toBeCloseTo(30, 0);
  }, 120_000);
});
