// TALKLESS ULTRA XMD – pairing page logic (Neon bridge)

const form = document.getElementById('pairForm');
const phoneInput = document.getElementById('phoneNumber');
const prefixInput = document.getElementById('prefixInput');
const keyGroup = document.getElementById('premiumKeyGroup');
const keyInput = document.getElementById('premiumKey');
const submitBtn = document.getElementById('submitBtn');
const statusBox = document.getElementById('statusBox');
const resultBox = document.getElementById('resultBox');
const pairingCode = document.getElementById('pairingCode');
const copyBtn = document.getElementById('copyBtn');
const botPill = document.getElementById('botPill');
const noticeBanner = document.getElementById('noticeBanner');

// ── country picker ────────────────────────────────────────────
const countryTrigger = document.getElementById('countryTrigger');
const countryDisplay = document.getElementById('countryDisplay');
const countryModal = document.getElementById('countryModal');
const countrySearch = document.getElementById('countrySearch');
const countryList = document.getElementById('countryList');
const countryEmpty = document.getElementById('countryEmpty');
const countryClose = document.getElementById('countryClose');
const countryError = document.getElementById('countryError');

let countries = [];
let selectedCountry = null;
let pollTimer = null;
let premiumMode = false;

/** Flag emoji are two regional indicators — decode them to ISO2 ("🇰🇪" → "KE"). */
function isoFromFlag(flag) {
  try {
    return [...flag].map((ch) => String.fromCharCode(ch.codePointAt(0) - 127397)).join('');
  } catch {
    return '';
  }
}

const digits = (s) => String(s || '').replace(/\D/g, '');

function setStatus(msg, tone) {
  statusBox.hidden = !msg;
  statusBox.className = 'status-box' + (tone ? ' show ' + tone : '');
  statusBox.textContent = msg || '';
}

async function readJson(res) {
  try { return await res.json(); } catch { return {}; }
}

/* ── country list ─────────────────────────────────────────── */

async function loadCountries() {
  try {
    const res = await fetch('/countries.json', { cache: 'force-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) throw new Error('empty');
    countries = list.map((c) => ({ ...c, iso: isoFromFlag(c.flag) }));
    renderCountryList(countries);
    countryError.classList.add('hidden');
    applyDefaultCountry();
  } catch {
    // Never fail silently: the dial-code box stays editable so nobody is stuck.
    countryError.classList.remove('hidden');
    if (!digits(prefixInput.value)) prefixInput.value = '';
    prefixInput.focus();
  }
}

/** Prefer the browser's region, then fall back to the primary market. */
function applyDefaultCountry() {
  if (selectedCountry) return;
  const region = (navigator.language || '').split('-')[1]?.toUpperCase();
  const byRegion = region ? countries.find((c) => c.iso === region) : null;
  const fallback = countries.find((c) => c.code === '+254') || countries[0];
  selectCountry(byRegion || fallback, { silent: true });
}

function renderCountryList(list) {
  countryEmpty.classList.toggle('hidden', list.length > 0);
  countryList.innerHTML = list
    .map(
      (c, i) => `<div class="country-option" role="button" tabindex="0" data-i="${i}">
        <span class="flag">${c.flag}</span>
        <span class="cname">${c.name}</span>
        <span class="ccode">${c.code}</span>
      </div>`
    )
    .join('');
  countryList._list = list;
}

function filterCountries(q) {
  const term = String(q || '').trim().toLowerCase();
  const numeric = digits(term);
  const list = !term
    ? countries
    : countries.filter(
        (c) =>
          c.name.toLowerCase().includes(term) ||
          c.iso.toLowerCase().includes(term) ||
          (numeric && digits(c.code).includes(numeric))
      );
  renderCountryList(list);
}

function selectCountry(c, opts = {}) {
  if (!c) return;
  selectedCountry = c;
  const prefix = digits(c.code);
  countryDisplay.innerHTML = `<span class="sel-flag">${c.flag}</span><span class="sel-name">${c.name}</span>`;
  prefixInput.value = prefix;
  if (!opts.silent) phoneInput.focus();
  closeCountryModal();
}

function openCountryModal() {
  countryModal.classList.add('show');
  countryTrigger.setAttribute('aria-expanded', 'true');
  countrySearch.value = '';
  filterCountries('');
  setTimeout(() => countrySearch.focus(), 60);
}

function closeCountryModal() {
  countryModal.classList.remove('show');
  countryTrigger.setAttribute('aria-expanded', 'false');
}

countryTrigger.addEventListener('click', openCountryModal);
countryClose.addEventListener('click', closeCountryModal);
countryModal.addEventListener('click', (e) => { if (e.target === countryModal) closeCountryModal(); });
countrySearch.addEventListener('input', (e) => filterCountries(e.target.value));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && countryModal.classList.contains('show')) closeCountryModal();
});

countryList.addEventListener('click', (e) => {
  const row = e.target.closest('.country-option');
  if (!row) return;
  selectCountry(countryList._list[Number(row.dataset.i)]);
});
countryList.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.country-option');
  if (!row) return;
  e.preventDefault();
  selectCountry(countryList._list[Number(row.dataset.i)]);
});

// keep the prefix box honest — digits only
prefixInput.addEventListener('input', () => {
  prefixInput.value = digits(prefixInput.value).slice(0, 6);
});

/* ── stats ────────────────────────────────────────────────── */

async function refreshStats() {
  try {
    const res = await fetch('/api/stats');
    const s = await readJson(res);
    if (s.botOnline === undefined) return;
    premiumMode = !!s.premiumMode;
    botPill.textContent = s.botOnline ? '● BOT ONLINE' : '○ BOT OFFLINE';
    botPill.className = 'pill' + (s.botOnline ? '' : ' off');
    keyGroup.classList.toggle('hidden', !premiumMode);
    keyInput.required = premiumMode;
    if (s.notice) {
      noticeBanner.textContent = s.notice;
      noticeBanner.classList.add('show');
    } else {
      noticeBanner.classList.remove('show');
    }
  } catch { /* stats optional */ }
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/* ── pairing ──────────────────────────────────────────────── */

function composePhone() {
  const prefix = digits(prefixInput.value);
  let local = digits(phoneInput.value).replace(/^0+/, '');
  // If someone pastes the whole international number into the local box, drop the prefix once.
  if (prefix && local.startsWith(prefix) && local.length - prefix.length >= 7) {
    local = local.slice(prefix.length);
  }
  return { prefix, local, phone: prefix + local };
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  stopPolling();
  resultBox.classList.remove('show');
  setStatus('', '');

  const { prefix, local, phone } = composePhone();

  if (!prefix) return setStatus('❌ Select your country, or type its dial code in the + box.', 'err');
  if (local.length < 7) return setStatus('❌ Enter the full number without the leading 0.', 'err');
  if (phone.length < 7 || phone.length > 15) {
    return setStatus('❌ That number is not a valid international WhatsApp number.', 'err');
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Requesting code…';

  try {
    const res = await fetch('/api/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, key: premiumMode ? keyInput.value.trim() : undefined }),
    });
    const data = await readJson(res);
    if (!res.ok || !data.id) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Generate Pairing Code';
      return setStatus('❌ ' + (data.error || 'Request failed.'), 'err');
    }

    setStatus('⏳ Waiting for the bot… usually under 30 seconds.', 'info');
    const started = Date.now();
    pollTimer = setInterval(async () => {
      try {
        const r = await fetch('/api/status?id=' + data.id);
        const st = await readJson(r);
        if (st.error) { stopPolling(); return finishErr(st.error); }

        if (st.status === 'code_generated' || st.status === 'connected') {
          stopPolling();
          submitBtn.disabled = false;
          submitBtn.textContent = 'Generate Pairing Code';
          setStatus('', '');
          pairingCode.textContent = st.pairing_code ? st.pairing_code.replace(/(\S{4})(?=\S)/g, '$1 ') : 'CODE';
          resultBox.classList.add('show');
        } else if (st.status === 'failed' || st.status === 'expired') {
          stopPolling();
          submitBtn.disabled = false;
          submitBtn.textContent = 'Generate Pairing Code';
          finishErr(st.error || 'Request ' + st.status + '. Try again.');
        } else if (Date.now() - started > 180000) {
          stopPolling();
          submitBtn.disabled = false;
          submitBtn.textContent = 'Generate Pairing Code';
          finishErr('⏰ Timed out after 3 minutes. Try again.');
        }
      } catch { /* keep polling */ }
    }, 2500);

  } catch (err) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Generate Pairing Code';
    setStatus('❌ Network error: ' + err.message, 'err');
  }
});

function finishErr(msg) {
  setStatus('❌ ' + msg, 'err');
  resultBox.classList.remove('show');
}

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pairingCode.textContent.replace(/\s/g, ''));
    copyBtn.textContent = '✓ Copied';
    setTimeout(() => { copyBtn.textContent = 'Copy Code'; }, 1500);
  } catch { /* clipboard blocked */ }
});

// boot: country list + bot status
loadCountries();
refreshStats();
setInterval(refreshStats, 20000);
