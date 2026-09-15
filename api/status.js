// GET /api/status?id=<requestId>  – polled by the frontend until a code appears.
//
// SECURITY: this endpoint is unauthenticated and request ids are sequential, so the response
// is limited to the fields the portal renders. It deliberately does NOT return phone, id,
// created_at or updated_at: publishing the phone number attached to every id turns this into
// a bulk phone-number scraper.
const { PREFIX, query } = require('./_db');

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

  const id = String((req.query && req.query.id) || '').replace(/\D/g, '');
  if (!id) return json(res, 400, { error: 'Missing id' });

  try {
    const { rows } = await query(
      `SELECT status, pairing_code, error, expires_at
         FROM ${PREFIX}pairing_requests WHERE id = $1`,
      [Number(id)]
    );
    if (!rows[0]) return json(res, 404, { error: 'Request not found' });
    const row = rows[0];
    return json(res, 200, {
      status: row.status,
      pairing_code: row.pairing_code,
      error: row.error,
      expires_at: row.expires_at,
    });
  } catch (e) {
    // Log the real error, tell the client nothing about the schema.
    console.error('[status]', e.message);
    return json(res, 500, { error: 'Internal server error.' });
  }
};
