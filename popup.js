const METER_LABELS = {
  extra_usage: 'Månadsbudget',
  five_hour: 'Session (5 h)',
  seven_day: 'Vecka – alla modeller',
  seven_day_opus: 'Vecka – Opus',
  seven_day_sonnet: 'Vecka – Sonnet',
  seven_day_oauth_apps: 'Vecka – Claude Code / appar',
};
const METERS = Object.keys(METER_LABELS);
const BADGE_LABELS = { extra_usage: 'Budget', five_hour: 'Session', seven_day: 'Vecka' };

// Fast färgordning per produkt (färgen följer produkten, aldrig rangordningen).
const PRODUCT_ORDER = ['claude_code', 'claude_design', 'cowork', 'chat'];

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

let currency = 'USD';
const money = (minor, digits = 2) => new Intl.NumberFormat('en-US',
  { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minor / 100);
const pctClass = (p) => (p >= 90 ? ' crit' : p >= 70 ? ' warn' : '');

function dateText(d, withTime) {
  return d.toLocaleString('sv-SE', withTime
    ? { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { weekday: 'short', day: 'numeric', month: 'short' });
}

function resetText(iso) {
  if (!iso) return '';
  const t = new Date(iso), ms = t - Date.now();
  if (isNaN(ms)) return '';
  if (ms <= 0) return 'Återställs nu';
  const h = Math.floor(ms / 36e5), m = Math.round((ms - h * 36e5) / 6e4);
  if (h < 24) return 'Återställs om ' + (h ? h + ' h ' : '') + m + ' min';
  return 'Återställs ' + dateText(t, true);
}

// ---- Månadsbudget (extra_usage) ------------------------------------------

function findNumber(obj, re, exclude) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === 'number' && re.test(k) && !(exclude && exclude.test(k))) return v;
  }
  return null;
}

// Tolkar extra_usage. Belopp anges normalt i cent (minor units); vi kontrollerar
// mot spend-datan och mot procentsatsen innan vi visar några belopp.
function readBudget(eu, spendTotalMinor) {
  const pct = eu.utilization;
  let limit = findNumber(eu, /limit|cap|budget/i);
  let used = findNumber(eu, /used|spent|credits|amount/i, /limit|util/i);
  if (limit == null && used != null && pct > 0) limit = used / (pct / 100);
  if (used == null && limit != null) used = limit * (pct / 100);

  let scale = 1; // 1 = cent, 100 = hela dollar
  if (used != null && spendTotalMinor > 0) {
    const asCents = Math.abs(used - spendTotalMinor) / spendTotalMinor;
    const asDollars = Math.abs(used * 100 - spendTotalMinor) / spendTotalMinor;
    if (asDollars < asCents) scale = 100;
  }
  const consistent = limit > 0 && used != null && Math.abs((used / limit) * 100 - pct) < 2;
  const now = new Date();
  const reset = eu.resets_at ? new Date(eu.resets_at)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return consistent
    ? { pct, used: used * scale, limit: limit * scale, reset }
    : { pct, reset };
}

function renderBudget(parent, eu, spend) {
  const total = spend?.totals?.reduce((s, t) => s + (t.cost_minor_units || 0), 0) || 0;
  const b = readBudget(eu, total);
  const pct = Math.max(0, Math.min(100, b.pct));
  const sec = el('section');
  sec.append(el('h2', '', 'Månadsbudget'));
  const hero = el('div', 'hero');
  if (b.used != null) {
    hero.append(document.createTextNode(money(b.used) + ' '),
                el('small', '', 'av ' + money(b.limit, b.limit % 100 ? 2 : 0)));
  } else {
    hero.append(document.createTextNode(Math.round(pct) + ' % '), el('small', '', 'av budgeten'));
  }
  const track = el('div', 'track');
  const bar = el('div', 'bar' + pctClass(pct));
  bar.style.width = pct + '%';
  track.append(bar);
  const sub = el('div', 'sub');
  sub.append(el('span', '', Math.round(pct) + ' % använt' +
    (b.used != null ? ' · ' + money(Math.max(0, b.limit - b.used)) + ' kvar' : '')),
    el('span', '', 'Återställs ' + dateText(b.reset, true)));
  sec.append(hero, track, sub);
  parent.append(sec);
}

// ---- Övriga mätare (Pro/Max: session och vecka) --------------------------

function renderMeters(parent, usage, keys) {
  if (!keys.length) return;
  const sec = el('section');
  for (const key of keys) {
    const v = usage[key];
    const pct = Math.max(0, Math.min(100, v.utilization));
    const row = el('div', 'row');
    const top = el('div', 'top');
    top.append(el('span', '', METER_LABELS[key]), el('strong', '', Math.round(pct) + ' %'));
    const track = el('div', 'track');
    const bar = el('div', 'bar' + pctClass(pct));
    bar.style.width = pct + '%';
    track.append(bar);
    const sub = el('div', 'sub');
    sub.append(el('span', '', resetText(v.resets_at)));
    row.append(top, track, sub);
    sec.append(row);
  }
  parent.append(sec);
}

// ---- Daglig kostnad per produkt (staplad stapelgraf) ---------------------

function renderSpend(parent, spend) {
  if (!spend?.series?.length) return;
  if (spend.currency) currency = spend.currency.toUpperCase();

  // Produkter i fast ordning, okända efter dem.
  const names = {};
  for (const s of spend.series) names[s.group_key] = s.group;
  for (const t of spend.totals || []) names[t.group_key] = t.group;
  const keys = [...PRODUCT_ORDER.filter((k) => names[k]),
                ...Object.keys(names).filter((k) => !PRODUCT_ORDER.includes(k))];
  const slot = (k) => 's' + Math.min(keys.indexOf(k) + 1, 9);

  // Alla dagar i perioden, även tomma.
  const days = [];
  const start = new Date(spend.start_date + 'T00:00:00Z'), end = new Date(spend.end_date + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  const byDay = Object.fromEntries(days.map((d) => [d, {}]));
  for (const s of spend.series) if (byDay[s.bucket]) byDay[s.bucket][s.group_key] = (byDay[s.bucket][s.group_key] || 0) + s.cost_minor_units;
  const dayTotal = (d) => Object.values(byDay[d]).reduce((a, b) => a + b, 0);

  const max = Math.max(...days.map(dayTotal), 1);
  const stepRaw = max / 100 / 3;
  const mag = Math.pow(10, Math.floor(Math.log10(stepRaw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= stepRaw) * 100;
  const yMax = Math.ceil(max / step) * step;

  const W = 328, H = 120, L = 34, B = 16, T = 4;
  const plotW = W - L, plotH = H - B - T;
  const slotW = plotW / days.length;
  const barW = Math.max(3, Math.min(12, slotW * 0.62));
  const y = (v) => T + plotH - (v / yMax) * plotH;

  const monthName = start.toLocaleString('sv-SE', { month: 'long', timeZone: 'UTC' });
  const sec = el('section');
  sec.append(el('h2', '', 'Kostnad per dag i ' + monthName));
  const wrap = el('div', 'chart');
  const s = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': 'Daglig kostnad per produkt' });

  for (let v = 0; v <= yMax; v += step) {
    s.append(svg('line', { class: v ? 'grid' : 'base', x1: L, x2: W, y1: y(v), y2: y(v) }));
    const t = svg('text', { x: L - 6, y: y(v) + 3, 'text-anchor': 'end' });
    t.textContent = money(v, 0);
    s.append(t);
  }

  const cols = [];
  days.forEach((d, i) => {
    const cx = L + slotW * i + slotW / 2;
    const col = svg('rect', { class: 'col', x: L + slotW * i, y: T, width: slotW, height: plotH, rx: 2 });
    s.append(col);
    cols.push(col);

    const present = keys.filter((k) => byDay[d][k] > 0);
    let acc = 0;
    present.forEach((k, j) => {
      const v = byDay[d][k];
      const y0 = y(acc), y1 = y(acc + v);
      acc += v;
      const isTop = j === present.length - 1;
      const gap = j > 0 ? 1 : 0; // 2px mellanrum mellan segment (1px var sida)
      const h = Math.max(0.5, y0 - y1 - gap - (isTop ? 0 : 1));
      const x = cx - barW / 2, yTop = y1 + (isTop ? 0 : 1);
      if (isTop) {
        const r = Math.min(3, barW / 2, h);
        s.append(svg('path', { class: slot(k),
          d: `M${x},${yTop + h}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + barW - r}Q${x + barW},${yTop} ${x + barW},${yTop + r}V${yTop + h}Z` }));
      } else {
        s.append(svg('rect', { class: slot(k), x, y: yTop, width: barW, height: h }));
      }
    });

    const dn = +d.slice(8);
    if (dn === 1 || dn % 7 === 1 || i === days.length - 1) {
      if (i === days.length - 1 && dn % 7 !== 1 && (dn % 7 <= 3)) return; // undvik krock med föregående etikett
      const t = svg('text', { x: cx, y: H - 3, 'text-anchor': 'middle' });
      t.textContent = dn + (dn === 1 ? ' ' + start.toLocaleString('sv-SE', { month: 'short', timeZone: 'UTC' }).replace('.', '') : '');
      s.append(t);
    }
  });

  // Hover-tooltip per dag
  const tip = el('div', 'tip');
  const hit = svg('rect', { x: L, y: 0, width: plotW, height: H, fill: 'transparent' });
  s.append(hit);
  let last = -1;
  hit.addEventListener('mousemove', (e) => {
    const rect = s.getBoundingClientRect();
    const i = Math.max(0, Math.min(days.length - 1, Math.floor((e.clientX - rect.left - L) / slotW)));
    if (i !== last) {
      cols.forEach((c, j) => c.classList.toggle('hover', j === i));
      const d = days[i];
      tip.textContent = '';
      const head = el('div', 't');
      head.append(el('span', '', dateText(new Date(d + 'T12:00:00Z'))), el('span', '', money(dayTotal(d))));
      tip.append(head);
      const present = keys.filter((k) => byDay[d][k] > 0).reverse();
      if (!present.length) tip.append(el('div', 'sub', 'Ingen användning'));
      for (const k of present) {
        const r = el('div', 'r');
        r.append(el('span', 'sw ' + slot(k)), el('span', '', names[k]), el('span', '', money(byDay[d][k])));
        tip.append(r);
      }
      last = i;
    }
    tip.style.display = 'block';
    const x = L + slotW * i + slotW / 2;
    const tw = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(W - tw, x - tw / 2)) + 'px';
    tip.style.top = (-tip.offsetHeight - 6) + 'px';
  });
  hit.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
    cols.forEach((c) => c.classList.remove('hover'));
    last = -1;
  });

  wrap.append(s, tip);
  sec.append(wrap);

  // Förklaring med månadssumma per produkt
  const totals = Object.fromEntries((spend.totals || []).map((t) => [t.group_key, t.cost_minor_units]));
  const legend = el('div', 'legend');
  for (const k of keys) {
    const sum = totals[k] ?? days.reduce((a, d) => a + (byDay[d][k] || 0), 0);
    const r = el('div', 'r');
    r.append(el('span', 'sw ' + slot(k)), el('span', '', names[k]), el('span', '', money(sum, 0)));
    legend.append(r);
  }
  sec.append(legend);
  parent.append(sec);
}

// ---- Rendering -------------------------------------------------------------

function render(state) {
  const box = $('#content');
  box.textContent = '';

  if (state?.error === 'not_logged_in' && !state.usage) {
    const msg = el('div', 'msg', 'Du verkar inte vara inloggad. ');
    const a = el('a', '', 'Logga in på claude.ai');
    a.href = 'https://claude.ai/login'; a.target = '_blank';
    msg.append(a);
    box.append(msg);
    $('#badgeWrap').style.visibility = 'hidden';
    return;
  }

  const usage = state?.usage;
  if (state?.spend?.currency) currency = state.spend.currency.toUpperCase();
  const avail = METERS.filter((k) => typeof usage?.[k]?.utilization === 'number');

  if (!avail.length && !state?.spend?.series?.length) {
    box.append(el('div', 'msg', state?.error
      ? 'Kunde inte hämta usage (' + state.error + ').'
      : 'Ingen usage-data hittades.'));
    return;
  }

  if (avail.includes('extra_usage')) renderBudget(box, usage.extra_usage, state.spend);
  renderMeters(box, usage, avail.filter((k) => k !== 'extra_usage'));
  renderSpend(box, state.spend);

  if (state.fetchedAt) {
    const when = new Date(state.fetchedAt).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    const note = el('div', 'sub');
    note.style.padding = '0 0 10px';
    note.append(el('span', '', (state.error ? 'Kunde inte uppdatera · senast hämtad ' : 'Uppdaterad ') + when));
    box.append(note);
  }

  // Välj vad ikonen visar – bara bland de mätare som finns.
  const sel = $('#badgeSource');
  const opts = avail.filter((k) => BADGE_LABELS[k]);
  $('#badgeWrap').style.visibility = opts.length > 1 ? 'visible' : 'hidden';
  if (sel.options.length !== opts.length) {
    sel.textContent = '';
    for (const k of opts) { const o = el('option', '', BADGE_LABELS[k]); o.value = k; sel.append(o); }
  }
  chrome.storage.local.get('badgeSource').then(({ badgeSource }) => {
    sel.value = opts.includes(badgeSource) ? badgeSource : opts[0] || '';
  });
}

async function refresh() {
  const btn = $('#refresh');
  btn.classList.add('spin');
  try {
    render(await chrome.runtime.sendMessage({ type: 'refresh' }));
  } finally {
    btn.classList.remove('spin');
  }
}

(async () => {
  const { state } = await chrome.storage.local.get('state');
  if (state) render(state);
  refresh();
})();

$('#refresh').addEventListener('click', refresh);
$('#badgeSource').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ badgeSource: e.target.value });
  chrome.runtime.sendMessage({ type: 'rebadge' });
});
$('#copyRaw').addEventListener('click', async () => {
  const { state } = await chrome.storage.local.get('state');
  const raw = { usage: state?.usage, spend_totals: state?.spend?.totals, error: state?.error };
  await navigator.clipboard.writeText(JSON.stringify(raw, null, 2));
  const b = $('#copyRaw'); b.textContent = 'Kopierat ✔';
  setTimeout(() => (b.textContent = 'Rådata'), 1500);
});
