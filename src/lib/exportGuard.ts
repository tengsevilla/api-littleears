import { AppError } from "./errors.js";

/**
 * R4: personalized songs (child_id set) can never be exported or uploaded anywhere.
 * Every export/upload path must call this before touching the song's media.
 */
export function assertExportable(song: { child_id: string | null }): void {
  if (song.child_id !== null) {
    throw new AppError(403, "FORBIDDEN", "Personalized songs cannot be exported");
  }
}
