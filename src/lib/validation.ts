import type { z } from "zod";
import { AppError } from "./errors.js";

/** Parses input or throws 400 VALIDATION with a readable, value-free message. */
export function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const message = parsed.error.issues
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
  throw new AppError(400, "VALIDATION", message);
}
