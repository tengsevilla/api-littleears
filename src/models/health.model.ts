import { db } from "../lib/db.js";

export async function pingDb(): Promise<void> {
  await db.query("SELECT 1");
}
