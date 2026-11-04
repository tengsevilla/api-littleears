// In-memory stand-in for lib/db.ts. Understands exactly the SQL the models issue,
// so tests exercise real controller + model code without a database.
type Row = Record<string, unknown>;

export type FakeState = {
  users: Row[];
  refresh_tokens: Row[];
  children: Row[];
  songs: Row[];
  jobs: Row[];
  invites: Row[];
  library_items: Row[];
  play_events: Row[];
};

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();
const result = (rows: Row[]) => [rows, []] as const;
const header = (affectedRows: number) => [{ affectedRows }, []] as const;

export function createFakeDb() {
  const state: FakeState = { users: [], refresh_tokens: [], children: [], songs: [], jobs: [], invites: [], library_items: [], play_events: [] };
  let clock = Date.UTC(2026, 0, 1);
  const now = () => new Date((clock += 1000)); // strictly increasing created_at

  async function query(rawSql: string, params: unknown[] = []) {
    const sql = norm(rawSql);
    const p = params;

    // users
    // users.email is utf8mb4_general_ci: case-insensitive
    if (/^SELECT [\w, ]+ FROM users WHERE email = \?/.test(sql)) {
      const want = String(p[0]).toLowerCase();
      return result(state.users.filter((u) => String(u.email).toLowerCase() === want));
    }
    if (sql.startsWith("SELECT id, email, role FROM users WHERE id = ?")) {
      return result(state.users.filter((u) => u.id === p[0]));
    }
    if (sql === "INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'parent')") {
      const [id, email, password_hash] = p;
      if (state.users.some((u) => String(u.email).toLowerCase() === String(email).toLowerCase())) {
        throw Object.assign(new Error("fakeDb: duplicate users.email"), { code: "ER_DUP_ENTRY" });
      }
      state.users.push({ id, email, password_hash, role: "parent", created_at: now() });
      return header(1);
    }

    // invites
    if (sql.startsWith("INSERT INTO invites")) {
      const [id, email, token_hash, created_by, expires_at] = p;
      state.invites.push({ id, email, token_hash, created_by, expires_at, used_at: null, revoked_at: null, created_at: now() });
      return header(1);
    }

    // library_items (PRIMARY KEY (user_id, song_id))
    const hasItem = (user_id: unknown, song_id: unknown) => state.library_items.some((li) => li.user_id === user_id && li.song_id === song_id);
    const addItem = (user_id: unknown, song_id: unknown, ignore: boolean) => {
      if (hasItem(user_id, song_id)) {
        if (ignore) return 0;
        throw Object.assign(new Error("fakeDb: duplicate library_items"), { code: "ER_DUP_ENTRY" });
      }
      state.library_items.push({ user_id, song_id, created_at: now() });
      return 1;
    };
    if (sql === "INSERT IGNORE INTO library_items (user_id, song_id) SELECT user_id, id FROM songs WHERE id = ? AND child_id IS NULL") {
      const song = state.songs.find((x) => x.id === p[0] && (x.child_id ?? null) === null);
      return header(song ? addItem(song.user_id, song.id, true) : 0);
    }
    if (sql === "INSERT IGNORE INTO library_items (user_id, song_id) VALUES (?, ?)") return header(addItem(p[0], p[1], true));
    if (sql === "INSERT INTO library_items (user_id, song_id) VALUES (?, ?)") return header(addItem(p[0], p[1], false));
    if (sql === "DELETE FROM library_items WHERE user_id = ? AND song_id = ?" || sql === "DELETE FROM library_items WHERE song_id = ?") {
      const match = p.length === 2 ? (li: Row) => li.user_id === p[0] && li.song_id === p[1] : (li: Row) => li.song_id === p[0];
      const before = state.library_items.length;
      state.library_items = state.library_items.filter((li) => !match(li));
      return header(before - state.library_items.length);
    }

    // Shared catalog (LEFT JOIN library_items) + its count
    const shared = (x: Row) => x.status === "ready" && (x.child_id ?? null) === null && (x.catalog_removed_at ?? null) === null;
    if (sql.startsWith("SELECT COUNT(*) AS total FROM songs s WHERE") || sql.includes("FROM songs s LEFT JOIN library_items li")) {
      const isList = sql.includes("LEFT JOIN");
      const args = [...p];
      const userId = isList ? args.shift() : undefined;
      if (isList) args.shift();
      const mood = sql.includes("s.mood = ?") ? args.shift() : undefined;
      const ageBand = sql.includes("s.age_band = ?") ? args.shift() : undefined;
      const rows = state.songs.filter((x) => shared(x) && (mood === undefined || x.mood === mood) && (ageBand === undefined || x.age_band === ageBand));
      if (!isList) return result([{ total: rows.length }]);
      const [limit, offset] = args as [number, number];
      return result(
        [...rows]
          .sort(comparator("approved_at DESC, id DESC"))
          .slice(offset, offset + limit)
          .map((x) => ({
            ...x,
            in_my_library: hasItem(userId, x.id) ? 1 : 0,
            mine: x.user_id === userId && (x.owner_deleted_at ?? null) === null ? 1 : 0,
          })),
      );
    }

    // Kid-player library: [own child's ready songs UNION ALL] library_items songs
    if (sql.includes("FROM library_items li JOIN songs s ON s.id = li.song_id")) {
      const withChild = sql.startsWith("SELECT s.id") && sql.includes("UNION ALL");
      const args = [...p];
      const own = withChild
        ? (() => {
            const [userId, childId] = [args.shift(), args.shift()];
            return state.songs.filter((x) => x.user_id === userId && x.child_id === childId && x.status === "ready");
          })()
        : [];
      const [userId] = [args.shift(), args.shift()];
      const items = state.library_items
        .filter((li) => li.user_id === userId)
        .map((li) => state.songs.find((x) => x.id === li.song_id))
        .filter((x): x is Row => !!x && x.status === "ready" && (x.child_id ?? null) === null && ((x.catalog_removed_at ?? null) === null || x.user_id === userId));
      return result([...own, ...items].sort(comparator("approved_at DESC, id DESC")).map((x) => ({ ...x })));
    }

    // play_events + admin stats (plays.model.ts)
    if (sql === "INSERT INTO play_events (user_id, song_id, sound_slug, played_at) VALUES (?, ?, ?, ?)") {
      const [user_id, song_id, sound_slug, played_at] = p;
      if (song_id !== null && !state.songs.some((x) => x.id === song_id)) throw new Error("fakeDb: FK play_events.song_id");
      state.play_events.push({ id: state.play_events.length + 1, user_id, song_id, sound_slug, played_at, created_at: now() });
      return header(1);
    }
    if (sql.includes("FROM play_events") && sql.includes("played_at >= ?")) {
      const isTop = sql.startsWith("SELECT s.id, s.title, s.status, s.image_key");
      const from = time(p[isTop ? 1 : 0]) as number;
      const inRange = state.play_events.filter((pe) => (time(pe.played_at) as number) >= from);
      const songOf = (id: unknown) => state.songs.find((x) => x.id === id);
      const distinctUsers = (rows: Row[]) => new Set(rows.map((r) => r.user_id)).size;
      const groupBy = (rows: Row[], key: (r: Row) => string) => {
        const m = new Map<string, Row[]>();
        for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
        return m;
      };
      const songPlays = (rows: Row[]) => rows.filter((r) => r.song_id !== null).length;
      const soundPlays = (rows: Row[]) => rows.filter((r) => r.sound_slug !== null).length;
      if (sql.startsWith("SELECT COUNT(*) AS plays, COUNT(song_id)")) {
        const times = inRange.map((pe) => time(pe.played_at) as number);
        return result([
          {
            plays: inRange.length,
            song_plays: songPlays(inRange),
            sound_plays: soundPlays(inRange),
            active_families: distinctUsers(inRange),
            first_played: times.length ? new Date(Math.min(...times)) : null,
          },
        ]);
      }
      if (sql.startsWith("SELECT DATE_FORMAT(played_at")) {
        const days = groupBy(inRange, (pe) => (pe.played_at as Date).toISOString().slice(0, 10));
        return result([...days].map(([day, rows]) => ({ day, song_plays: songPlays(rows), sound_plays: soundPlays(rows) })));
      }
      if (isTop) {
        const [adminId, , ownerId] = p;
        const bySong = groupBy(inRange.filter((pe) => pe.song_id !== null), (pe) => String(pe.song_id));
        const rows = [...bySong]
          .map(([id, plays]) => ({ x: songOf(id), plays }))
          .filter((r): r is { x: Row; plays: Row[] } => !!r.x && (shared(r.x) || r.x.user_id === ownerId))
          .map(({ x, plays }): Row & { plays: number } => ({
            ...x,
            mine: x.user_id === adminId && (x.owner_deleted_at ?? null) === null ? 1 : 0,
            plays: plays.length,
            families: distinctUsers(plays),
            library_adds: state.library_items.filter((li) => li.song_id === x.id).length,
          }))
          .sort((a, b) => b.plays - a.plays || String(a.title ?? "").localeCompare(String(b.title ?? "")) || String(a.id).localeCompare(String(b.id)));
        return result(rows.slice(0, 20));
      }
      if (sql.startsWith("SELECT COUNT(*) AS plays FROM play_events pe JOIN songs s")) {
        const adminId = p[1];
        const personal = inRange.filter((pe) => {
          const x = songOf(pe.song_id);
          return !!x && (x.child_id ?? null) !== null && x.user_id !== adminId;
        });
        return result([{ plays: personal.length }]);
      }
      if (sql.startsWith("SELECT sound_slug AS slug")) {
        const bySound = groupBy(inRange.filter((pe) => pe.sound_slug !== null), (pe) => String(pe.sound_slug));
        return result(
          [...bySound].map(([slug, rows]) => ({ slug, plays: rows.length, families: distinctUsers(rows) })).sort((a, b) => b.plays - a.plays || a.slug.localeCompare(b.slug)),
        );
      }
    }
    if (sql.startsWith("SELECT (SELECT COUNT(*) FROM users) AS families")) {
      const from = time(p[0]) as number;
      return result([
        {
          families: state.users.length,
          songs_created: state.songs.filter((x) => (time(x.created_at) as number) >= from && (x.owner_deleted_at ?? null) === null).length,
          shared_songs: state.songs.filter(shared).length,
        },
      ]);
    }

    // refresh_tokens
    if (sql.startsWith("INSERT INTO refresh_tokens")) {
      const [id, user_id, family_id, token_hash, expires_at] = p;
      state.refresh_tokens.push({ id, user_id, family_id, token_hash, expires_at, revoked_at: null });
      return header(1);
    }
    if (sql.includes("FROM refresh_tokens WHERE token_hash = ? FOR UPDATE")) {
      return result(state.refresh_tokens.filter((t) => t.token_hash === p[0]));
    }
    if (sql.startsWith("UPDATE refresh_tokens SET revoked_at = NOW() WHERE")) {
      const col = /WHERE (\w+) = \?/.exec(sql)?.[1] ?? "";
      const onlyActive = sql.includes("revoked_at IS NULL");
      const hits = state.refresh_tokens.filter((t) => t[col] === p[0] && (!onlyActive || t.revoked_at === null));
      for (const t of hits) t.revoked_at = now();
      return header(hits.length);
    }

    // children
    if (sql.startsWith("SELECT id, display_name, phonetic_name, age_band, created_at FROM children")) {
      if (sql.includes("WHERE id = ? AND user_id = ?")) {
        return result(state.children.filter((c) => c.id === p[0] && c.user_id === p[1]));
      }
      return result(state.children.filter((c) => c.user_id === p[0]));
    }
    if (sql.startsWith("INSERT INTO children")) {
      const [id, user_id, display_name, phonetic_name, age_band] = p;
      state.children.push({ id, user_id, display_name, phonetic_name, age_band, created_at: now() });
      return header(1);
    }
    if (sql.startsWith("UPDATE children SET")) {
      const cols = [...sql.matchAll(/(\w+) = \?/g)].map((m) => m[1] as string);
      const values = p.slice(0, -2);
      const [id, userId] = p.slice(-2);
      const hits = state.children.filter((c) => c.id === id && c.user_id === userId);
      for (const c of hits) cols.slice(0, values.length).forEach((col, i) => (c[col] = values[i]));
      return header(hits.length);
    }
    if (sql === "SELECT id FROM children WHERE id = ? AND user_id = ? FOR UPDATE") {
      return result(state.children.filter((c) => c.id === p[0] && c.user_id === p[1]).map((c) => ({ id: c.id })));
    }
    if (sql.startsWith("DELETE FROM children WHERE id = ? AND user_id = ?")) {
      // songs.child_id is ON DELETE RESTRICT
      if (state.songs.some((s) => s.child_id === p[0])) throw new Error("fakeDb: FK RESTRICT songs.child_id");
      const before = state.children.length;
      state.children = state.children.filter((c) => !(c.id === p[0] && c.user_id === p[1]));
      return header(before - state.children.length);
    }

    // songs (jobs cascade on song delete)
    if (sql === "SELECT id, raw_audio_key, audio_key, image_key, video_key FROM songs WHERE user_id = ? AND child_id = ? FOR UPDATE") {
      return result(state.songs.filter((s) => s.user_id === p[0] && s.child_id === p[1]));
    }
    if (sql === "DELETE FROM songs WHERE user_id = ? AND child_id = ?") {
      return header(deleteSongs((s) => s.user_id === p[0] && s.child_id === p[1]));
    }

    // Generic songs / jobs / children statements (Phase 4 models + worker).
    if (sql.startsWith("INSERT INTO songs")) {
      const [id, user_id, child_id, topic, mood, age_band, length_sec] = p;
      state.songs.push({
        id, user_id, child_id, topic, mood, age_band, length_sec,
        status: /'(\w+)'\)$/.exec(sql)?.[1] ?? "queued",
        title: null, lyrics: null, music_prompt: null, image_prompt: null, safety_result: null,
        raw_audio_key: null, audio_key: null, image_key: null, video_key: null,
        duration_ms: null, error: null, approved_at: null, created_at: now(), updated_at: null,
      });
      return header(1);
    }
    if (sql.startsWith("INSERT INTO jobs")) {
      const [id, song_id, step, regen_part] = p;
      if (!state.songs.some((s) => s.id === song_id)) throw new Error("fakeDb: FK jobs.song_id");
      state.jobs.push({ id, song_id, step, regen_part, attempts: 0, safety_regens: 0, run_after: now(), locked_at: null, done_at: null, last_error: null });
      return header(1);
    }
    const sel = /^SELECT (.+?) FROM (songs|jobs|children|invites|play_events)(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\d+))?(?: FOR UPDATE(?: SKIP LOCKED)?)?$/.exec(sql);
    if (sel) {
      const [, , table, where, orderBy, limit] = sel;
      const args = [...p];
      const pred = where ? compileWhere(where, args) : () => true;
      let rows = state[table as "songs"].filter(pred);
      if (orderBy) rows = [...rows].sort(comparator(orderBy));
      if (limit) rows = rows.slice(0, Number(limit));
      return result(rows.map((r) => ({ ...r })));
    }
    const upd = /^UPDATE (songs|jobs|invites|users) SET (.+) WHERE (.+)$/.exec(sql);
    if (upd) {
      const [, table, sets, where] = upd;
      const args = [...p];
      const assigns = (sets as string).split(/, (?=\w+ = )/).map((a) => {
        const [col, expr] = a.split(" = ") as [string, string];
        return [col, evalExpr(expr, args)] as const;
      });
      const pred = compileWhere(where as string, args);
      const hits = state[table as "songs"].filter(pred);
      for (const row of hits) for (const [col, v] of assigns) row[col] = v;
      return header(hits.length);
    }
    if (sql === "DELETE FROM songs WHERE id = ? AND user_id = ?") {
      return header(deleteSongs((s) => s.id === p[0] && s.user_id === p[1]));
    }
    if (sql === "DELETE FROM songs WHERE id = ?") {
      return header(deleteSongs((s) => s.id === p[0]));
    }

    throw new Error(`fakeDb: unhandled SQL: ${sql}`);
  }

  /** Deletes matching songs; jobs and library_items cascade (ON DELETE CASCADE). */
  function deleteSongs(match: (s: Row) => boolean): number {
    const gone = new Set(state.songs.filter(match).map((s) => s.id));
    state.songs = state.songs.filter((s) => !gone.has(s.id));
    state.jobs = state.jobs.filter((j) => !gone.has(j.song_id));
    state.library_items = state.library_items.filter((li) => !gone.has(li.song_id));
    state.play_events = state.play_events.filter((pe) => !gone.has(pe.song_id));
    return gone.size;
  }

  // --- tiny SQL expression evaluator (only the forms our models use) ---------------------------
  function evalExpr(expr: string, args: unknown[]): unknown {
    if (expr === "?") return args.shift();
    if (expr === "NULL") return null;
    if (expr === "NOW()") return now();
    if (expr === "NOW() + INTERVAL ? SECOND") return new Date(now().getTime() + Number(args.shift()) * 1000);
    const minus = /^NOW\(\) - INTERVAL (\d+) MINUTE$/.exec(expr);
    if (minus) return new Date(now().getTime() - Number(minus[1]) * 60_000);
    const lit = /^'(.*)'$/.exec(expr);
    if (lit) return lit[1];
    if (/^-?\d+$/.test(expr)) return Number(expr);
    throw new Error(`fakeDb: unhandled expression: ${expr}`);
  }

  const time = (v: unknown) => (v instanceof Date ? v.getTime() : v);

  function compileWhere(where: string, args: unknown[]): (row: Row) => boolean {
    const preds = where.split(" AND ").map((cond): ((row: Row) => boolean) => {
      const or = /^\((\w+) IS NULL OR (\w+) = \?\)$/.exec(cond);
      if (or) {
        const v = args.shift();
        return (r) => r[or[1] as string] === null || r[or[2] as string] === v;
      }
      let m = /^(\w+) IS (NOT )?NULL$/.exec(cond);
      if (m) {
        const [, col, not] = m;
        return (r) => (r[col as string] === null || r[col as string] === undefined) !== !!not;
      }
      m = /^(\w+) IN \(\?\)$/.exec(cond);
      if (m) {
        const list = args.shift() as unknown[];
        const col = m[1] as string;
        return (r) => list.includes(r[col]);
      }
      m = /^(\w+) (=|<=|<|>) (.+)$/.exec(cond);
      if (m) {
        const [, col, op, expr] = m;
        const v = time(evalExpr(expr as string, args));
        return (r) => {
          const x = time(r[col as string]) as number;
          if (op === "=") return x === v;
          if (x === null || x === undefined) return false;
          if (op === ">") return x > (v as number);
          return op === "<=" ? x <= (v as number) : x < (v as number);
        };
      }
      throw new Error(`fakeDb: unhandled condition: ${cond}`);
    });
    return (row) => preds.every((f) => f(row));
  }

  function comparator(orderBy: string): (a: Row, b: Row) => number {
    const keys = orderBy.split(", ").map((k) => {
      const [col, dir] = k.split(" ") as [string, string | undefined];
      return { col, sign: dir === "DESC" ? -1 : 1 };
    });
    return (a, b) => {
      for (const { col, sign } of keys) {
        const x = time(a[col]) as number | string | null;
        const y = time(b[col]) as number | string | null;
        if (x === y) continue;
        if (x === null) return -sign; // NULLs sort first ascending, as in MySQL
        if (y === null) return sign;
        return (x < y ? -1 : 1) * sign;
      }
      return 0;
    };
  }

  // Transactions: snapshot on begin, restore on rollback, so tests can assert "DB unchanged".
  let snapshot: FakeState | null = null;
  const conn = {
    query,
    beginTransaction: async () => {
      snapshot = structuredClone(state);
    },
    commit: async () => {
      snapshot = null;
    },
    rollback: async () => {
      if (snapshot) Object.assign(state, snapshot);
      snapshot = null;
    },
    release: () => {},
  };

  return {
    state,
    db: { query, getConnection: async () => conn },
    /** Moves the fake NOW() forward (e.g. past a retry backoff). */
    advance(ms: number) {
      clock += ms;
    },
    /** Current fake NOW() without advancing it. */
    peekNow: () => new Date(clock),
    reset() {
      state.users = [];
      state.refresh_tokens = [];
      state.children = [];
      state.songs = [];
      state.jobs = [];
      state.invites = [];
      state.library_items = [];
      state.play_events = [];
    },
  };
}
