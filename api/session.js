// POST /api/session         – queue a pasted TALKLESS session ID for the bot
// GET  /api/session?id=<n>  – poll what happened to that submission
//
// The bot polls `talkless_session_submissions` every 5s (helper/talkless-neon.js,
// startSessionSubmissionLoop). A row here is the ONLY hand-off: validate the paste,
// derive the phone number from creds.me.id, insert, then let the bot write
// ./sessions/web_<phone>/creds.json and open the socket.
//
// SECURITY: the session string is a full WhatsApp credential. It is never returned to
// the client, never written to logs, and GET only exposes status/error plus a masked
// phone, because ids are sequential and this endpoint is unauthenticated.
const { PREFIX, query } = require('./_db');

const TABLE = `${PREFIX}session_submissions`;
const MAX_BODY = 262144;      // 256 KB – a real creds payload is ~1-3 KB
const MAX_PER_HOUR = 8;       // per phone number
const MASK = (p) => (p ? p.slice(0, 4) + '•'.repeat(Math.max(0, p.length - 7)) + p.slice(-3) : '');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

// Accepts every shape the bot's own parser accepts: Talkless!<b64>, TALKLESS-MD!<b64>,
// bare base64, base64url, a JSON string, or any of those wrapped in a code fence.
function parseSession(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('Paste the session ID first.');
  let s = raw.replace(/```[a-zA-Z]*/g, '').replace(/```/g, '').trim();
  s = s.replace(/^talkless(-?md)?!\s*/i, '').trim();
  if (s.length > MAX_BODY) throw new Error('That session ID is too large.');

  let parsed;
  if (s.startsWith('{')) {
    try { parsed = JSON.parse(s); } catch { throw new Error('That JSON is not valid.'); }
  } else {
    // base64url -> base64, then decode. Buffer never throws on bad input, so the
    // JSON.parse below is what rejects garbage.
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const text = Buffer.from(b64, 'base64').toString('utf8');
    try { parsed = JSON.parse(text); } catch { throw new Error('That is not a valid session ID (it did not decode to JSON).'); }
  }

  const creds = parsed && parsed.creds ? parsed.creds : parsed;
  if (!creds || typeof creds !== 'object') throw new Error('That session ID has no credentials inside.');
  if (!creds.me || !creds.me.id) throw new Error('That session ID has no creds.me.id, so the phone number cannot be read.');
  if (!creds.noiseKey && !creds.signedIdentityKey) throw new Error('That looks like a bare snippet, not a full creds.json.');

  const phone = String(creds.me.id).split(/[:@]/)[0].replace(/\D/g, '');
  if (phone.length < 7 || phone.length > 15) throw new Error('That session ID has no usable phone number.');

  return { phone, payload: creds };
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('Payload too large.');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Error('Body must be JSON.'); }
}

let _tableReady = false;
async function ensureTable() {
  if (_tableReady) return;
  // Created by hand in Neon already; this is the safety net for a switched database.
  await query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id BIGSERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    session TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    claimed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  _tableReady = true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();

  // ── poll ───────────────────────────────────────────────────
  if (req.method === 'GET') {
    const id = String((req.query && req.query.id) || '').replace(/\D/g, '');
    if (!id) return json(res, 400, { error: 'Missing id' });
    try {
      const { rows } = await query(
        `SELECT status, error, phone, updated_at FROM ${TABLE} WHERE id = $1`,
        [Number(id)]
      );
      if (!rows[0]) return json(res, 404, { error: 'Submission not found' });
      const r = rows[0];
      return json(res, 200, {
        status: r.status,
        error: r.error || null,
        phone: MASK(r.phone),
        updated_at: r.updated_at,
      });
    } catch (e) {
      console.error('[session:get]', e.message);
      return json(res, 500, { error: 'Internal server error.' });
    }
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  // ── submit ─────────────────────────────────────────────────
  let phone;
  let session;
  try {
    const body = await readBody(req);
    const parsed = parseSession(body.session || body.sessionId || body.id);
    phone = parsed.phone;
    session = String(body.session || body.sessionId || body.id).trim();
  } catch (e) {
    return json(res, 400, { error: e.message });
  }

  try {
    await ensureTable();

    const recent = await query(
      `SELECT count(*)::int AS n FROM ${TABLE}
        WHERE phone = $1 AND created_at > now() - interval '1 hour'`,
      [phone]
    );
    if (recent.rows[0].n >= MAX_PER_HOUR) {
      return json(res, 429, { error: 'Too many attempts for this number. Wait a few minutes and try again.' });
    }

    // Drop any queued paste for the same number: the newest one wins, otherwise the
    // bot would replay an older, already-invalid creds.json first.
    await query(
      `UPDATE ${TABLE} SET status = 'failed', error = 'Replaced by a newer paste.', updated_at = now()
        WHERE phone = $1 AND status IN ('pending', 'claimed', 'connecting')`,
      [phone]
    );

    const { rows } = await query(
      `INSERT INTO ${TABLE} (phone, session, status) VALUES ($1, $2, 'pending')
       RETURNING id, created_at`,
      [phone, session]
    );

    console.log('[session:post] queued submission', rows[0].id, 'for', MASK(phone));
    return json(res, 200, {
      success: true,
      id: rows[0].id,
      phone: MASK(phone),
      message: 'Session received. The bot picks it up within 5 seconds.',
    });
  } catch (e) {
    console.error('[session:post]', e.message);
    return json(res, 500, { error: 'Could not queue the session. Try again in a moment.' });
  }
};
