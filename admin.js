// TALKLESS ULTRA – admin dashboard logic
let pw = sessionStorage.getItem('tl_admin_pw') || '';

const $ = (id) => document.getElementById(id);
const loginCard = $('loginCard');
const panel = $('panel');

function setLoginMsg(msg, tone) {
  const box = $('loginMsg');
  box.hidden = !msg;
  box.className = 'status-box' + (msg ? ' show ' + tone : '');
  box.textContent = msg || '';
}

async function api(action, extra = {}, method) {
  const res = await fetch('/api/admin?action=' + encodeURIComponent(action), {
    method: method || 'POST',
    headers: { 'Content-Type': 'application/json', ...(pw ? { 'X-Admin-Password': pw } : {}) },
    body: JSON.stringify(extra),
  });
  return res.json();
}

async function tryLogin(showErr = true) {
  pw = $('pw').value.trim() || pw;
  const d = await api('login', { password: pw });
  if (d.success) {
    sessionStorage.setItem('tl_admin_pw', pw);
    loginCard.classList.add('hidden');
    panel.classList.remove('hidden');
    await refreshAll();
    return true;
  }
  if (showErr) setLoginMsg(d.error || 'Login failed.', 'err');
  return false;
}

async function refreshStats() {
  const d = await api('stats');
  if (d.error) return;
  $('stOnline').textContent = d.onlineNow;
  $('stTotal').textContent = d.totalSessions;
  $('stKeys').textContent = d.keysLeft;
  $('stPrem').textContent = d.premiumMode ? 'ON' : 'OFF';
  $('premiumBtn').textContent = d.premiumMode ? 'Disable Premium Mode' : 'Enable Premium Mode';
  $('noticeInput').value = d.notice || '';
}

async function refreshKeys() {
  const d = await api('keys');
  if (d.error) return;
  $('keysList').innerHTML = (d.keys || []).slice(0, 30).map(k =>
    `<div class="row"><span>${k.key}</span><span class="tag ${k.status === 'unused' ? 'on' : 'off'}">${k.status}${k.used_phone ? ' · ' + k.used_phone : ''}</span></div>`
  ).join('') || '<p class="sub">No keys yet.</p>';
}

// Session ids come from the database, so they are escaped before going into markup.
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function tagClass(status) {
  return status === 'connected' ? 'on' : status === 'disconnected' ? 'off' : 'x';
}

async function refreshSessions() {
  const d = await api('sessions');
  if (d.error) return;
  $('sessionsList').innerHTML = (d.sessions || []).slice(0, 40).map(s =>
    `<div class="row">` +
      `<span class="mono sess-id">${esc(s.id)}</span>` +
      `<span class="sess-right">` +
        `<span class="tag ${tagClass(s.status)}">${esc(s.status)}</span>` +
        `<button type="button" class="del-btn" data-id="${esc(s.id)}">Delete</button>` +
      `</span>` +
    `</div>`
  ).join('') || '<p class="sub">No sessions yet.</p>';
}

function setSessionsMsg(msg, tone) {
  const box = $('sessionsMsg');
  box.textContent = msg || '';
  box.className = 'status-box' + (msg ? ' show ' + tone : '');
}

// One delegated listener, so re-rendering the list never leaves stale handlers behind.
$('sessionsList').addEventListener('click', async (event) => {
  const btn = event.target.closest('.del-btn');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  if (!confirm(
    `Delete session ${id}?\n\n` +
    `This removes the row from the database, so the portal will stop listing it. ` +
    `It does NOT unlink WhatsApp — revoke the device with /delpair on the bot.`)) return;

  btn.disabled = true;
  btn.textContent = '…';
  const d = await api('delete_session', { id });
  if (d.success) {
    setSessionsMsg(`✓ Deleted ${d.deleted}`, 'ok');
    await refreshSessions();
    await refreshStats();
    setTimeout(() => setSessionsMsg(''), 2500);
  } else {
    setSessionsMsg('❌ ' + (d.error || 'Delete failed'), 'err');
    await refreshSessions();
  }
});

// Bulk path: count first with a dry run, then delete only what was counted.
$('clearSessionsBtn').addEventListener('click', async () => {
  const btn = $('clearSessionsBtn');
  btn.disabled = true;
  try {
    const preview = await api('clear_sessions', { dryRun: true });
    if (preview.error) {
      setSessionsMsg('❌ ' + preview.error, 'err');
      return;
    }
    const n = preview.wouldClear || 0;
    if (!n) {
      setSessionsMsg('Nothing to delete — no disconnected sessions.', 'info');
      return;
    }
    if (!confirm(`Delete ${n} disconnected session${n === 1 ? '' : 's'}?\n\n` +
                 `This cannot be undone. Connected sessions are never touched.`)) return;
    const d = await api('clear_sessions', {});
    if (d.success) {
      setSessionsMsg(`✓ Deleted ${d.cleared} disconnected session${d.cleared === 1 ? '' : 's'}`, 'ok');
      await refreshSessions();
      await refreshStats();
    } else {
      setSessionsMsg('❌ ' + (d.error || 'Delete failed'), 'err');
    }
  } finally {
    btn.disabled = false;
  }
});

async function refreshAll() {
  await refreshStats();
  await refreshKeys();
  await refreshSessions();
  await refreshDb();
}

async function refreshDb() {
  const d = await api('current_db');
  if (d.success) $('curDbHost').textContent = d.host || d.url;
}

$('switchDbBtn').addEventListener('click', async () => {
  const box = $('dbMsg');
  const url = $('dbUrl').value.trim();
  if (!url) {
    box.textContent = '❌ Paste a connection string first.';
    box.className = 'status-box show err';
    return;
  }
  box.textContent = '⏳ Connecting to new DB…';
  box.className = 'status-box show info';
  const d = await api('switch_db', { url });
  if (d.success) {
    // The API returns host + a masked string, never the raw connection string.
    box.textContent = '✅ Switched to: ' + (d.host || d.urlMasked || '');
    box.className = 'status-box show ok';
    $('dbUrl').value = '';
    await refreshAll();
  } else {
    box.textContent = '❌ ' + (d.error || 'Switch failed');
    box.className = 'status-box show err';
  }
});

$('loginBtn').addEventListener('click', () => tryLogin());
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });

$('saveNoticeBtn').addEventListener('click', async () => {
  const d = await api('set_notice', { notice: $('noticeInput').value });
  if (!d.error) { const b = $('newKey'); b.textContent = '✓ Notice saved'; b.className = 'status-box show ok'; setTimeout(() => b.className = 'status-box', 2000); }
});

$('premiumBtn').addEventListener('click', async () => {
  const cur = $('premiumBtn').textContent.startsWith('Enable');
  await api('set_premium', { enabled: cur });
  await refreshStats();
});

$('genKeyBtn').addEventListener('click', async () => {
  const d = await api('generate_key');
  const b = $('newKey');
  if (d.key) {
    b.textContent = '🔑 ' + d.key;
    b.className = 'status-box show ok';
    await refreshKeys();
  } else {
    b.textContent = '❌ ' + (d.error || 'Failed');
    b.className = 'status-box show err';
  }
});

(async () => {
  if (pw) { const ok = await tryLogin(false); if (!ok) sessionStorage.removeItem('tl_admin_pw'); }
})();
