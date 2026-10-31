// In-process generation worker. Started by server.ts only (never by app.ts, so tests stay
// worker-free unless they call runNextJob / startWorker themselves).
import { env } from "../lib/env.js";
import * as JobsModel from "../models/jobs.model.js";
import { runJob } from "./pipeline.js";

const STALE_CHECK_EVERY_MS = 60_000;
const STOP_WAIT_MS = 10_000;

/** Claims and runs one job. False when nothing is runnable. */
export async function runNextJob(): Promise<boolean> {
  const job = await JobsModel.claimNextJob();
  if (!job) return false;
  await runJob(job);
  return true;
}

export type Worker = { stop(): Promise<void> };

/**
 * Polls every `pollMs`; one job at a time, draining the queue each tick. Resets stale locks on
 * boot (and every minute after, so a crash-restart within 10 min is still recovered).
 */
export function startWorker(pollMs = env.WORKER_POLL_MS): Worker {
  let stopped = false;
  let current: Promise<void> | null = null;
  let lastStaleCheck = 0;

  const tick = () => {
    if (current || stopped) return;
    current = (async () => {
      try {
        if (Date.now() - lastStaleCheck >= STALE_CHECK_EVERY_MS) {
          lastStaleCheck = Date.now();
          const reset = await JobsModel.resetStaleLocks();
          if (reset > 0) console.info(`[worker] reset ${reset} stale job lock(s)`);
        }
        while (!stopped && (await runNextJob())) {
          // drain
        }
      } catch (err) {
        // Job stays locked; the stale-lock reset recovers it.
        console.error("[worker] tick failed:", err instanceof Error ? `${err.name}: ${err.message}` : err);
      }
    })().finally(() => {
      current = null;
    });
  };

  const timer = setInterval(tick, pollMs);
  tick();
  console.info(`[worker] started (poll ${pollMs} ms)`);

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      // Let an in-flight step finish briefly; if it doesn't, its lock goes stale and is reset on next boot.
      if (current) await Promise.race([current, new Promise((r) => setTimeout(r, STOP_WAIT_MS).unref())]);
    },
  };
}
