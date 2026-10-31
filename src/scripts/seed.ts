// Ensures the admin account from SEED_USER_EMAIL / SEED_USER_PASSWORD exists with role 'admin'.
// Idempotent: re-running keeps role='admin' and never resets an existing password
// (the password is only used when the account is first created). Run with `npm run db:seed`.
// Never prints the email or password.
import { randomUUID } from "node:crypto";
import { env } from "../lib/env.js";
import { db } from "../lib/db.js";
import { hashPassword } from "../lib/password.js";
import * as UserModel from "../models/user.model.js";

async function main() {
  const email = env.SEED_USER_EMAIL;
  const password = env.SEED_USER_PASSWORD;
  const missing = [!email && "SEED_USER_EMAIL", !password && "SEED_USER_PASSWORD"].filter(Boolean);
  if (!email || !password) {
    throw new Error(`Missing required env var(s): ${missing.join(", ")}`);
  }
  const result = await UserModel.upsertAdmin(randomUUID(), email, await hashPassword(password));
  console.log(`Seed complete: admin user ${result}.`);
}

main()
  .catch((err: unknown) => {
    console.error("Seed failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.end());
