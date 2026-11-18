// 2075: static site (public/) plus the leaderboard API, stored in D1.
//
//   GET  /api/top?mode=1|2   -> 200 { mode, rows: [[initials, score], ...] }  best first
//   POST /api/top?mode=1|2   body: the game's table [[initials, score], ...] (1 to 5 rows)
//                            -> 200 { mode, rows } (the merged board)
//
// A POST never replaces the board. Every row is validated first; one bad row rejects the
// whole request. Valid rows are merged into what is stored (exact repeats are ignored) and
// only the best KEEP rows per mode are kept. Rows are never deleted any other way, so a
// request can add scores but cannot remove or reorder existing ones.

const KEEP = 10; // rows kept on each board
const MAX_ROWS = 5; // rows accepted per request: the game's own table holds five
const MAX_SCORE = 9_999_999;
const MAX_BODY = 2048; // bytes; a full table of five rows is well under 200
const INITIALS = /^[A-Z]{3}$/;

type Mode = 1 | 2;
type Row = [string, number];

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, url);
    } catch (err) {
      console.error(JSON.stringify({ message: 'api_error', path: url.pathname, method: request.method, error: String(err) }));
      return json({ error: 'internal_error', message: 'Something went wrong. Try again later.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname !== '/api/top') return json({ error: 'not_found', message: 'Unknown endpoint.' }, 404);

  const mode = parseMode(url.searchParams.get('mode'));
  if (!mode) return json({ error: 'bad_mode', message: 'mode must be 1 (one player) or 2 (two players).' }, 400);

  if (request.method === 'GET' || request.method === 'HEAD') {
    return json({ mode, rows: await board(env.DB, mode) });
  }
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed', message: 'Use GET or POST.' }, 405, { allow: 'GET, HEAD, POST' });
  }

  // A JSON content type also keeps browsers from posting here cross-site without a preflight.
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return json({ error: 'unsupported_media_type', message: 'Send the table as application/json.' }, 415);
  }

  const text = await readBody(request, MAX_BODY);
  if (text === null) return json({ error: 'too_large', message: `The body must be at most ${MAX_BODY} bytes.` }, 413);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'bad_json', message: 'The body is not valid JSON.' }, 400);
  }

  const problem = checkTable(body);
  if (problem) return json({ error: 'bad_table', message: problem }, 400);
  const rows = body as Row[];

  // Counted only for requests that would write.
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.WRITE_LIMIT.limit({ key: ip });
  if (!success) return json({ error: 'rate_limited', message: 'Too many writes. Try again in a minute.' }, 429, { 'retry-after': '60' });

  const db = env.DB;
  const insert = db.prepare('INSERT OR IGNORE INTO scores (mode, initials, score) VALUES (?1, ?2, ?3)');
  // One batch is one transaction: insert, trim to the best KEEP, read the board back.
  const results = await db.batch([
    ...rows.map(([initials, score]) => insert.bind(mode, initials, score)),
    db
      .prepare('DELETE FROM scores WHERE mode = ?1 AND id NOT IN (SELECT id FROM scores WHERE mode = ?1 ORDER BY score DESC, id ASC LIMIT ?2)')
      .bind(mode, KEEP),
    boardQuery(db, mode),
  ]);
  const last = results[results.length - 1] as D1Result<{ initials: string; score: number }>;
  return json({ mode, rows: toRows(last.results) });
}

function parseMode(value: string | null): Mode | null {
  return value === '1' ? 1 : value === '2' ? 2 : null;
}

// Returns a message for the first problem found, or null when the table is valid.
function checkTable(body: unknown): string | null {
  if (!Array.isArray(body)) return 'The body must be an array of [initials, score] rows.';
  if (body.length < 1 || body.length > MAX_ROWS) return `The table must have 1 to ${MAX_ROWS} rows.`;
  for (let i = 0; i < body.length; i++) {
    const row: unknown = body[i];
    if (!Array.isArray(row) || row.length !== 2) return `Row ${i} must be [initials, score].`;
    const [initials, score] = row as unknown[];
    if (typeof initials !== 'string' || !INITIALS.test(initials)) return `Row ${i}: initials must be three letters A-Z.`;
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > MAX_SCORE) {
      return `Row ${i}: score must be an integer from 1 to ${MAX_SCORE}.`;
    }
  }
  return null;
}

function boardQuery(db: D1Database, mode: Mode): D1PreparedStatement {
  return db.prepare('SELECT initials, score FROM scores WHERE mode = ?1 ORDER BY score DESC, id ASC LIMIT ?2').bind(mode, KEEP);
}

async function board(db: D1Database, mode: Mode): Promise<Row[]> {
  const { results } = await boardQuery(db, mode).all<{ initials: string; score: number }>();
  return toRows(results);
}

function toRows(results: { initials: string; score: number }[]): Row[] {
  return results.map((r) => [r.initials, r.score]);
}

// Reads the body as text, or returns null as soon as it grows past `max` bytes.
async function readBody(request: Request, max: number): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? 0) > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });
}
