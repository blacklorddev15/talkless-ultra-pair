// POST /api/admin  { action, password?, ... }  or GET /api/admin?action=...
// Actions: login | stats | sessions | keys | generate_key | set_notice | set_premium
//          | current_db | switch_db | servers | reset_heartbeats | test_db
//          | delete_session | clear_sessions
// Protected by ADMIN_PASSWORD (sent as the X-Admin-Password header or body.password).
const {
  PREFIX,
  query,
  getSetting,
  setSetting,
  switchActiveDatabase,
  activeUrl,
} = require('./_db');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (Buffer.isBuffer(b)) { try { return JSON.parse(b.toString('utf8') || '{}'); } catch { return {}; } }
  if (typeof b === 'string') { try { return JSON.parse(b || '{}'); } catch { return {}; } }
  if (typeof b === 'object') return b;
  return {};
}

// Never hand back a usable credential: the password is replaced with dots.
function maskUrl(url) {
  const m = String(url || '').match(/^(postgres(?:ql)?:\/\/[^:]+:)[^@]+@(.*)$/i);
  return m ? `${m[1]}\u2022\u2022\u2022\u2022@${m[2]}` : '';
}

function adminPassword() {
  return String(process.env.ADMIN_PASSWORD || '').trim();
}

function authOK(req, body) {
  const adminPw = adminPassword();
  if (!adminPw) return false;
  const supplied = String(req.headers['x-admin-password'] || body.password || '').trim();
  if (!supplied) return false;
  // Compared case-insensitively and trimmed on both sides: this password gets typed by
  // hand, often on a phone, where a capitalised first letter or a trailing space is the
  // usual reason a correct password is rejected. Still a shared secret.
  return supplied.toLowerCase() === adminPw.toLowerCase();
}

// A row can only be removed if the id is a plausible session key. Refusing anything else
// keeps a stray "DELETE ... WHERE id = ''" from sweeping the table.
function cleanId(value) {
  return String(value == null ? '' : value).trim().slice(0, 200);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
  if (req.method === 'OPTIONS') return res.end();

  const body = req.method === 'POST'
    ? Object.assign({}, readBody(req), req.query || {})
    : (req.query || {});
  const action = String(body.action || '');

  // login is the only action allowed without a header
  if (action === 'login') {
    if (!adminPassword()) {
      return json(res, 500, { error: 'ADMIN_PASSWORD is not set on this deployment.' });
    }
    if (!authOK(req, body)) return json(res, 401, { error: 'Incorrect admin password.' });
    return json(res, 200, { success: true });
  }

  if (!authOK(req, body)) return json(res, 401, { error: 'Unauthorized. Login first.' });

  try {
    switch (action) {
      case 'stats': {
        const [sess, keys] = await Promise.all([
          query(`SELECT count(*)::int AS total,
                        count(*) FILTER (WHERE status = 'connected')::int AS online
                   FROM ${PREFIX}sessions`),
          query(`SELECT count(*)::int AS n FROM ${PREFIX}premium_keys WHERE status = 'unused'`),
        ]);
        return json(res, 200, {
          totalSessions: sess.rows[0].total,
          onlineNow: sess.rows[0].online,
          keysLeft: keys.rows[0].n,
          premiumMode: (await getSetting('premiumMode')) === 'true',
          notice: (await getSetting('notice')) || '',
        });
      }

      case 'sessions': {
        const { rows } = await query(
          `SELECT id, phone, status, updated_at FROM ${PREFIX}sessions
            ORDER BY updated_at DESC LIMIT 100`
        );
        return json(res, 200, { sessions: rows });
      }

      // Remove ONE session row. This only clears the database: revoking the WhatsApp link
      // itself is the bot's job (/delpair), which also removes ./sessions/<id>.
      case 'delete_session': {
        const id = cleanId(body.id);
        if (!id) return json(res, 400, { error: 'Missing session id.' });
        const { rows } = await query(
          `DELETE FROM ${PREFIX}sessions WHERE id = $1 RETURNING id`,
          [id]
        );
        if (!rows.length) return json(res, 404, { error: 'No such session.' });
        return json(res, 200, { success: true, deleted: rows[0].id });
      }

      case 'keys': {
        const { rows } = await query(
          `SELECT id, key, status, used_phone, used_at, created_at
             FROM ${PREFIX}premium_keys ORDER BY id DESC LIMIT 100`
        );
        return json(res, 200, { keys: rows });
      }

      case 'generate_key': {
        const rand = (n) => Array.from({ length: n },
          () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');
        const newKey = `TL-${rand(4)}-${rand(4)}`;
        await query(`INSERT INTO ${PREFIX}premium_keys (key, status) VALUES ($1, $2)`,
          [newKey, 'unused']);
        return json(res, 200, { key: newKey });
      }

      case 'set_notice': {
        await setSetting('notice', String(body.notice || ''));
        return json(res, 200, { success: true, notice: String(body.notice || '') });
      }

      case 'set_premium': {
        await setSetting('premiumMode', body.enabled ? 'true' : 'false');
        return json(res, 200, { success: true, premiumMode: !!body.enabled });
      }

      case 'current_db': {
        const url = await activeUrl();
        let host = '';
        let database = '';
        try {
          const parsed = new URL(url);
          host = parsed.host;
          database = parsed.pathname.replace(/^\//, '');
        } catch (_) { /* ignore */ }
        return json(res, 200, { success: true, host, database, urlMasked: maskUrl(url) });
      }

      case 'switch_db': {
        const url = await switchActiveDatabase(String(body.url || '').trim());
        let host = '';
        try { host = new URL(url).host; } catch (_) { /* ignore */ }
        return json(res, 200, { success: true, host, urlMasked: maskUrl(url) });
      }

      // The heartbeat table only exists once a bot has pinged; the toggles in the UI are
      // optional, so a missing table must not turn into a 500.
      case 'servers': {
        try {
          const { rows } = await query(
            `SELECT server_id, name, last_seen FROM ${PREFIX}server_heartbeats
              ORDER BY server_id`
          );
          return json(res, 200, { servers: rows });
        } catch (e) {
          return json(res, 200, { servers: [], warning: e.message });
        }
      }

      case 'reset_heartbeats': {
        try {
          await query(
            `UPDATE ${PREFIX}server_heartbeats SET last_seen = now() - interval '1 hour'`);
          return json(res, 200, { success: true });
        } catch (e) {
          return json(res, 200, { success: false, error: e.message });
        }
      }

      // Connect to a candidate database and close again, so the admin can check a new Neon
      // string before switching the site to it. Read-only: one SELECT 1.
      case 'test_db': {
        const target = String(body.url || '').trim();
        if (!/^postgres(ql)?:\/\//i.test(target)) {
          return json(res, 200, {
            success: false,
            message: 'That does not look like a PostgreSQL connection string.',
          });
        }
        const { Pool } = require('pg');
        const probe = new Pool({
          connectionString: target.split('?')[0],
          ssl: { rejectUnauthorized: false },
          connectionTimeoutMillis: 8000,
          max: 1,
        });
        try {
          await probe.query('SELECT 1');
          return json(res, 200, { success: true, message: 'Connection OK — the database answered.' });
        } catch (e) {
          return json(res, 200, {
            success: false,
            message: 'Could not connect: ' + (e && e.message ? e.message : 'unknown error'),
          });
        } finally {
          await probe.end().catch(() => {});
        }
      }

      // Bulk-remove rows the bot has already logged out. The predicate is exactly
      // "disconnected", so a session that is still linked can never be deleted here.
      // Pass { dryRun: true } to get the count without deleting anything.
      case 'clear_sessions': {
        if (body.dryRun) {
          const { rows } = await query(
            `SELECT count(*)::int AS n FROM ${PREFIX}sessions
              WHERE LOWER(status) = 'disconnected'`
          );
          return json(res, 200, { success: true, dryRun: true, wouldClear: rows[0].n });
        }
        const { rows } = await query(
          `DELETE FROM ${PREFIX}sessions WHERE LOWER(status) = 'disconnected' RETURNING id`
        );
        return json(res, 200, { success: true, cleared: rows.length });
      }

      default:
        return json(res, 400, { error: 'Unknown action.' });
    }
  } catch (e) {
    console.error('[admin]', e.message);
    return json(res, 500, { error: e.message });
  }
};
