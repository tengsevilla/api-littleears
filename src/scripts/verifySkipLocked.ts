// Verifies the worker's pick query semantics on the real DB (MariaDB 11.4 locally) with two
// connections: while connection A holds the first runnable row locked, connection B must get the
// NEXT row immediately (SKIP LOCKED) instead of blocking or getting the same row.
// Uses a throwaway table shaped like `jobs` so no real job can be claimed (a running worker would
// otherwise pick probe rows). Run with `npm run db:verify-skip-locked`.
import type { RowDataPacket } from "mysql2";
import { createMigrationConnection } from "../lib/db.js";
import { PICK_JOB_SQL } from "../models/jobs.model.js";

const TABLE = "skip_locked_probe";
const PICK = PICK_JOB_SQL.replace("FROM jobs", `FROM ${TABLE}`);

async function main() {
  const setup = await createMigrationConnection();
  const a = await createMigrationConnection();
  const b = await createMigrationConnection();
  try {
    const [[version]] = await setup.query<RowDataPacket[]>("SELECT VERSION() AS v");
    console.log(`Server: ${version?.v}`);
    await setup.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await setup.query(`CREATE TABLE ${TABLE} LIKE jobs`);
    // LIKE copies indexes but not FKs, so probe rows need no song.
    await setup.query(
      `INSERT INTO ${TABLE} (id, song_id, step, run_after) VALUES ('job-1', 'x', 'writing', NOW() - INTERVAL 2 MINUTE), ('job-2', 'x', 'writing', NOW() - INTERVAL 1 MINUTE)`,
    );
    await b.query("SET SESSION innodb_lock_wait_timeout = 3");

    await a.beginTransaction();
    const [ra] = await a.query<RowDataPacket[]>(PICK);
    await b.beginTransaction();
    const started = Date.now();
    const [rb] = await b.query<RowDataPacket[]>(PICK);
    const waitedMs = Date.now() - started;
    await b.rollback();
    await a.rollback();

    const [explain] = await setup.query<RowDataPacket[]>(`EXPLAIN ${PICK}`);
    console.log(`A picked ${ra[0]?.id}; B picked ${rb[0]?.id} after ${waitedMs} ms`);
    console.log(`EXPLAIN: type=${explain[0]?.type} key=${explain[0]?.key}`);
    if (ra[0]?.id !== "job-1" || rb[0]?.id !== "job-2" || waitedMs > 1000) {
      throw new Error("SKIP LOCKED did not behave as expected");
    }
    console.log("OK: FOR UPDATE SKIP LOCKED works — concurrent pickers never block or double-pick.");
  } finally {
    await setup.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
    await Promise.all([setup.end(), a.end(), b.end()]);
  }
}

main().catch((err: unknown) => {
  console.error("Verification failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
