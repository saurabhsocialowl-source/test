/* Couch popup — thin control panel that drives the content script. */

const $ = (sel) => document.querySelector(sel);
const views = {
  notNetflix: $('#not-netflix'),
  lobby: $('#lobby'),
  party: $('#party'),
};

let activeTab = null;

function show(view) {
  Object.values(views).forEach((v) => v.classList.add('hidden'));
  view.classList.remove('hidden');
}

function isNetflixWatch(url) {
  return /^https?:\/\/[^/]*netflix\.com\/watch\//.test(url || '');
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToContent(msg) {
  return new Promise((resolve) => {
    if (!activeTab) return resolve(null);
    chrome.tabs.sendMessage(activeTab.id, msg, (resp) => {
      // Ignore "no receiver" errors — surfaced as null.
      void chrome.runtime.lastError;
      resolve(resp || null);
    });
  });
}

function renderParty(status) {
  $('#room-code').textContent = status.room || '——';
  const conn = $('#conn');
  conn.textContent = status.connected ? 'Connected — in sync 🟢' : 'Connecting…';
  conn.className = 'conn ' + (status.connected ? 'ok' : 'bad');

  const ul = $('#members');
  ul.innerHTML = '';
  (status.members || [status.name]).forEach((m) => {
    const li = document.createElement('li');
    li.textContent = m;
    ul.appendChild(li);
  });

  $('#mic').classList.toggle('off', !status.micOn);
  $('#mic').textContent = (status.micOn ? '🎤' : '🔇') + ' Mic';
  $('#cam').classList.toggle('off', !status.camOn);
  $('#cam').textContent = (status.camOn ? '📷' : '🚫') + ' Cam';
}

async function refresh() {
  const status = await sendToContent({ type: 'get-status' });
  if (status && status.inParty) {
    show(views.party);
    renderParty(status);
  } else {
    show(views.lobby);
  }
}

async function init() {
  activeTab = await getActiveTab();

  // Prefill name + server from storage.
  const cfg = await chrome.storage.local.get(['couchName', 'couchServerUrl']);
  if (cfg.couchName) $('#name').value = cfg.couchName;
  $('#server-url').value = cfg.couchServerUrl || 'ws://localhost:8080';

  if (!activeTab || !isNetflixWatch(activeTab.url)) {
    show(views.notNetflix);
    return;
  }
  await refresh();
}

function readConfig() {
  const name = $('#name').value.trim() || 'Guest';
  const serverUrl = $('#server-url').value.trim() || 'ws://localhost:8080';
  chrome.storage.local.set({ couchName: name, couchServerUrl: serverUrl });
  return { name, serverUrl };
}

// ---- Event wiring ----------------------------------------------------------

$('#open-netflix').onclick = () => chrome.tabs.create({ url: 'https://www.netflix.com' });

$('#create').onclick = async () => {
  const { name, serverUrl } = readConfig();
  const resp = await sendToContent({ type: 'create-party', name, serverUrl });
  if (resp) await refresh();
};

$('#join').onclick = async () => {
  const room = $('#join-code').value.trim().toUpperCase();
  if (!room) { $('#join-code').focus(); return; }
  const { name, serverUrl } = readConfig();
  const resp = await sendToContent({ type: 'join-party', room, name, serverUrl });
  if (resp) await refresh();
};

$('#copy').onclick = async () => {
  const code = $('#room-code').textContent;
  await navigator.clipboard.writeText(code);
  $('#copy').textContent = 'Copied!';
  setTimeout(() => ($('#copy').textContent = 'Copy'), 1200);
};

$('#mic').onclick = async () => { await sendToContent({ type: 'toggle-mic' }); refresh(); };
$('#cam').onclick = async () => { await sendToContent({ type: 'toggle-cam' }); refresh(); };
$('#leave').onclick = async () => { await sendToContent({ type: 'leave-party' }); refresh(); };

// Live-update the party view while the popup is open.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.couchStatus && !views.party.classList.contains('hidden')) {
    renderParty(changes.couchStatus.newValue || {});
  }
});

init();
