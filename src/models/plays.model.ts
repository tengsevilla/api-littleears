// Play events + admin stats (CLAUDE.md "Play tracking + admin stats").
// played_at is always written from a JS Date (UTC; the pool uses timezone "Z"), never NOW().
import type { RowDataPacket } from "mysql2";
import { db } from "../lib/db.js";
import { isSharedRow, mediaUrl, type SongStatus } from "./songs.model.js";

/** Exactly one of songId / soundSlug (the table has no CHECK for this — see the migration). */
export type PlayItem = { songId: string; soundSlug?: undefined } | { soundSlug: string; songId?: undefined };

export const DEDUPE_MS = 30_000;
const TOP_SONGS = 20;

/** A song this user may play: their own ready song (not deleted by them), or any shared song. */
export async function isPlayableSong(songId: string, userId: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT user_id, child_id, status, owner_deleted_at, catalog_removed_at FROM songs WHERE id = ? LIMIT 1",
    [songId],
  );
  const r = rows[0];
  if (!r) return false;
  const ownReady = r.user_id === userId && r.status === "ready" && (r.owner_deleted_at ?? null) === null;
  return ownReady || isSharedRow(r);
}

/**
 * Records a play unless the same user played the same item within 30 s of `playedAt` (either side:
 * offline plays can arrive out of order). Returns false when deduped. Uses idx_play_events_user_played.
 */
export async function record(userId: string, item: PlayItem, playedAt: Date): Promise<boolean> {
  const [col, value] = item.songId !== undefined ? ["song_id", item.songId] : ["sound_slug", item.soundSlug];
  const [dupes] = await db.query<RowDataPacket[]>(
    `SELECT id FROM play_events WHERE user_id = ? AND ${col} = ? AND played_at > ? AND played_at < ? LIMIT 1`,
    [userId, value, new Date(playedAt.getTime() - DEDUPE_MS), new Date(playedAt.getTime() + DEDUPE_MS)],
  );
  if (dupes.length > 0) return false;
  await db.query("INSERT INTO play_events (user_id, song_id, sound_slug, played_at) VALUES (?, ?, ?, ?)", [
    userId,
    item.songId ?? null,
    item.soundSlug ?? null,
    playedAt,
  ]);
  return true;
}

export type AdminStats = {
  totals: {
    plays: number;
    songPlays: number;
    soundPlays: number;
    activeFamilies: number;
    families: number;
    songsCreated: number;
    sharedSongs: number;
  };
  daily: { date: string; songPlays: number; soundPlays: number }[];
  topSongs: { id: string; title: string | null; imageUrl: string | null; plays: number; families: number; libraryAdds: number; mine: boolean }[];
  personalizedPlays: number;
  topSounds: { slug: string; plays: number; families: number }[];
};

const n = (v: unknown) => Number(v ?? 0);
const DAY_MS = 86_400_000;
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Stats for plays at or after `since` (`null` = all time). Aggregation is in SQL; `daily` is
 * zero-filled here from `since` (or the first play) to `now`, by UTC date.
 * Privacy: topSongs only ever holds songs that are shared or owned by `adminId`. Plays of other
 * accounts' personalized songs only count towards personalizedPlays (titles can contain a child's name).
 */
export async function stats(adminId: string, since: Date | null, now: Date): Promise<AdminStats> {
  const from = since ?? new Date(0);
  const [[totals], [[counts]], [daily], [topSongs], [[personal]], [topSounds]] = await Promise.all([
    db.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS plays, COUNT(song_id) AS song_plays, COUNT(sound_slug) AS sound_plays, COUNT(DISTINCT user_id) AS active_families, MIN(played_at) AS first_played FROM play_events WHERE played_at >= ?",
      [from],
    ),
    db.query<RowDataPacket[]>(
      "SELECT (SELECT COUNT(*) FROM users) AS families, (SELECT COUNT(*) FROM songs WHERE created_at >= ? AND owner_deleted_at IS NULL) AS songs_created, (SELECT COUNT(*) FROM songs WHERE child_id IS NULL AND status = 'ready' AND catalog_removed_at IS NULL) AS shared_songs",
      [from],
    ),
    db.query<RowDataPacket[]>(
      "SELECT DATE_FORMAT(played_at, '%Y-%m-%d') AS day, COUNT(song_id) AS song_plays, COUNT(sound_slug) AS sound_plays FROM play_events WHERE played_at >= ? GROUP BY day",
      [from],
    ),
    db.query<RowDataPacket[]>(
      `SELECT s.id, s.title, s.status, s.image_key, (s.user_id = ? AND s.owner_deleted_at IS NULL) AS mine, p.plays, p.families,
         (SELECT COUNT(*) FROM library_items li WHERE li.song_id = s.id) AS library_adds
       FROM (SELECT song_id, COUNT(*) AS plays, COUNT(DISTINCT user_id) AS families FROM play_events WHERE song_id IS NOT NULL AND played_at >= ? GROUP BY song_id) p
       JOIN songs s ON s.id = p.song_id
       WHERE (s.status = 'ready' AND s.child_id IS NULL AND s.catalog_removed_at IS NULL) OR s.user_id = ?
       ORDER BY p.plays DESC, s.title ASC, s.id ASC LIMIT ${TOP_SONGS}`,
      [adminId, from, adminId],
    ),
    db.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS plays FROM play_events pe JOIN songs s ON s.id = pe.song_id WHERE pe.played_at >= ? AND s.child_id IS NOT NULL AND s.user_id <> ?",
      [from, adminId],
    ),
    db.query<RowDataPacket[]>(
      "SELECT sound_slug AS slug, COUNT(*) AS plays, COUNT(DISTINCT user_id) AS families FROM play_events WHERE sound_slug IS NOT NULL AND played_at >= ? GROUP BY sound_slug ORDER BY plays DESC, slug ASC",
      [from],
    ),
  ]);

  const t = totals[0];
  const byDay = new Map(daily.map((r) => [String(r.day), r]));
  const start = since ?? (t?.first_played ? new Date(t.first_played) : null);
  const days: AdminStats["daily"] = [];
  if (start) {
    for (let d = Date.parse(utcDay(start)); d <= now.getTime(); d += DAY_MS) {
      const date = utcDay(new Date(d));
      const r = byDay.get(date);
      days.push({ date, songPlays: n(r?.song_plays), soundPlays: n(r?.sound_plays) });
    }
  }

  return {
    totals: {
      plays: n(t?.plays),
      songPlays: n(t?.song_plays),
      soundPlays: n(t?.sound_plays),
      activeFamilies: n(t?.active_families),
      families: n(counts?.families),
      songsCreated: n(counts?.songs_created),
      sharedSongs: n(counts?.shared_songs),
    },
    daily: days,
    topSongs: topSongs.map((r) => ({
      id: r.id,
      title: r.title ?? null,
      imageUrl: mediaUrl(r.id, "image", r.image_key, r.status as SongStatus),
      plays: n(r.plays),
      families: n(r.families),
      libraryAdds: n(r.library_adds),
      mine: Boolean(Number(r.mine)),
    })),
    personalizedPlays: n(personal?.plays),
    topSounds: topSounds.map((r) => ({ slug: String(r.slug), plays: n(r.plays), families: n(r.families) })),
  };
}
