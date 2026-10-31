// Idempotent migration runner: applies schema/migrations/*.sql in filename order,
// recording each applied file in `schema_migrations`. Run with `npm run db:migrate`.
// Note: DDL auto-commits in MySQL/MariaDB, so a file that fails midway is not rolled back —
// fix the file/DB by hand, then re-run.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { RowDataPacket } from "mysql2";
import { createMigrationConnection } from "../lib/db.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "schema", "migrations");

async function main() {
  const conn = await createMigrationConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       VARCHAR(255) PRIMARY KEY,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);

    const [rows] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.name as string));

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log(`Up to date (${files.length} migration(s) applied).`);
      return;
    }

    for (const file of pending) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`Applying ${file} ...`);
      await conn.query(sql);
      await conn.query("INSERT INTO schema_migrations (name) VALUES (?)", [file]);
    }
    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await conn.end();
  }
}

main().catch((err: unknown) => {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
