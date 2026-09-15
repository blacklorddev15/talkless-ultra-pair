// GET /api/stats – the numbers the landing page shows.
//
// Returns exactly the fields this portal already published (totalPairs, onlineNow, today,
// botOnline, premiumMode, keysLeft, notice) so nothing consuming this endpoint sees a
// change in shape.
//
// There is no `talkless_server_heartbeats` table in this database — the Ultra bot does not
// ping — so "the bot is up" is decided from proof of work instead: a connected session, or
// recent session/pairing-request activity.
const { PREFIX, query, getSetting } = require('./_db');

const BOT_ACTIVITY_FRESH_MS = 10 * 60 * 1000;

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();

  try {
    const [sess, keys, today] = await Promise.all([
      query(`SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE status = 'connected')::int AS online
               FROM ${PREFIX}sessions`),
      query(`SELECT count(*)::int AS n FROM ${PREFIX}premium_keys WHERE status = 'unused'`),
      query(`SELECT count(*)::int AS n FROM ${PREFIX}pairing_requests
              WHERE created_at::date = current_date`),
    ]);

    const onlineNow = sess.rows[0].online;

    // Recent work by the bot: a session or a claimed request touched in the last 10 minutes.
    let activityFresh = false;
    try {
      const act = await query(
        `SELECT GREATEST(
                  COALESCE((SELECT max(updated_at) FROM ${PREFIX}sessions), 'epoch'::timestamptz),
                  COALESCE((SELECT max(updated_at) FROM ${PREFIX}pairing_requests
                             WHERE status IN ('processing','code_generated','connected')),
                           'epoch'::timestamptz)
                ) AS last`
      );
      const t = act.rows[0] && act.rows[0].last ? new Date(act.rows[0].last).getTime() : 0;
      activityFresh = t > 0 && Date.now() - t < BOT_ACTIVITY_FRESH_MS;
    } catch (e) {
      console.error('[stats] activity query:', e && e.message);
    }

    return json(res, 200, {
      totalPairs: sess.rows[0].total,
      onlineNow,
      today: today.rows[0].n,
      botOnline: onlineNow > 0 || activityFresh,
      premiumMode: (await getSetting('premiumMode')) === 'true',
      keysLeft: keys.rows[0].n,
      notice: (await getSetting('notice')) || '',
    });
  } catch (e) {
    console.error('[stats]', e.message);
    return json(res, 500, { error: e.message });
  }
};
