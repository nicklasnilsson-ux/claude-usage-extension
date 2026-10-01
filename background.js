// Hämtar usage och kostnader från claude.ai i bakgrunden och visar procent på ikonen.
const BASE = 'https://claude.ai';
const REFRESH_MINUTES = 5;

async function getJSON(path) {
  const r = await fetch(BASE + path, { credentials: 'include' });
  if (r.status === 401 || r.status === 403) throw new Error('not_logged_in');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function getOrgId() {
  const c = await chrome.cookies.get({ url: BASE, name: 'lastActiveOrg' });
  if (c?.value) return c.value;
  const orgs = await getJSON('/api/organizations');
  if (!Array.isArray(orgs) || !orgs.length) throw new Error('not_logged_in');
  return (orgs.find((o) => o.capabilities?.includes('chat')) || orgs[0]).uuid;
}

// Datum i UTC (samma som claude.ai:s graf), yyyy-mm-dd
const ymd = (d) => d.toISOString().slice(0, 10);

// Vilka mätare som finns, i visningsordning. Används av både ikon och popup.
const METERS = ['extra_usage', 'five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'];

function availableMeters(usage) {
  return METERS.filter((k) => typeof usage?.[k]?.utilization === 'number');
}

function colorFor(pct) {
  return pct >= 90 ? '#e5484d' : pct >= 70 ? '#e8912d' : '#c96442';
}

async function updateBadge(state) {
  if (state.error && !state.usage) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#6b6a68' });
    chrome.action.setTitle({
      title: state.error === 'not_logged_in'
        ? 'Claude Usage – logga in på claude.ai'
        : 'Claude Usage – kunde inte hämta (' + state.error + ')',
    });
    return;
  }
  const { badgeSource } = await chrome.storage.local.get('badgeSource');
  const avail = availableMeters(state.usage);
  const key = avail.includes(badgeSource) ? badgeSource : avail[0];
  const pct = key ? Math.round(state.usage[key].utilization) : null;
  chrome.action.setBadgeText({ text: pct == null ? '' : String(pct) });
  if (pct != null) chrome.action.setBadgeBackgroundColor({ color: colorFor(pct) });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });

  const names = { extra_usage: 'Budget', five_hour: 'Session', seven_day: 'Vecka' };
  const parts = avail.filter((k) => names[k]).map((k) => names[k] + ' ' + Math.round(state.usage[k].utilization) + ' %');
  chrome.action.setTitle({ title: 'Claude Usage' + (parts.length ? ' – ' + parts.join(', ') : '') });
}

async function refresh() {
  const prev = (await chrome.storage.local.get('state')).state || {};
  const state = { usage: prev.usage || null, spend: prev.spend || null, fetchedAt: prev.fetchedAt || null };
  try {
    const org = await getOrgId();
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [usage, spend] = await Promise.allSettled([
      getJSON('/api/organizations/' + org + '/usage'),
      getJSON('/api/organizations/' + org + '/usage/spend?start_date=' + ymd(start) +
              '&end_date=' + ymd(now) + '&group_by=product_surface&granularity=daily'),
    ]);
    if (usage.status === 'rejected') throw usage.reason;
    state.usage = usage.value;
    state.spend = spend.status === 'fulfilled' ? spend.value : null;
    state.fetchedAt = Date.now();
    delete state.error;
  } catch (e) {
    state.error = e.message;
  }
  await chrome.storage.local.set({ state });
  await updateBadge(state);
  return state;
}

function schedule() {
  chrome.alarms.create('refresh', { periodInMinutes: REFRESH_MINUTES });
  refresh();
}
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'refresh') refresh(); });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'refresh') {
    refresh().then(sendResponse);
    return true;
  }
  if (msg?.type === 'rebadge') {
    chrome.storage.local.get('state').then(({ state }) => state && updateBadge(state));
  }
});
