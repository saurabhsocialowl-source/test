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

async function getActiveTab() {
  // Only the tab id is needed (always available without the "tabs" permission).
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

let currentLink = '';
function renderParty(status) {
  $('#room-code').textContent = status.room || '——';
  const conn = $('#conn');
  conn.textContent = status.connected ? 'Connected — in sync 🟢' : 'Connecting…';
  conn.className = 'conn ' + (status.connected ? 'ok' : 'bad');

  // Invite link is only "open the same show" once the host is on a title.
  currentLink = status.link || '';
  const onTitle = !!status.videoId;
  $('#copy-link').textContent = onTitle ? '🔗 Copy invite link' : '🔗 Copy join link';
  $('#link-hint').textContent = onTitle
    ? 'Share this link — it opens this exact show and joins the party automatically.'
    : 'Open a Netflix title to get a link that opens the same show. For now this link just joins the party.';

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

  // Prefill name + (optional) broker from storage.
  const cfg = await chrome.storage.local.get(['couchName', 'couchBrokerHost']);
  if (cfg.couchName) $('#name').value = cfg.couchName;
  if (cfg.couchBrokerHost) $('#broker-host').value = cfg.couchBrokerHost;

  // The content script runs on every netflix.com page. If it answers, we're on
  // Netflix and can create/join a party (no need to be playing something yet).
  const status = await sendToContent({ type: 'get-status' });
  if (!status) {
    show(views.notNetflix);
    return;
  }
  if (status.inParty) { show(views.party); renderParty(status); }
  else show(views.lobby);
}

function readConfig() {
  const name = $('#name').value.trim() || 'Guest';
  const brokerHost = $('#broker-host').value.trim(); // '' => free PeerJS cloud
  chrome.storage.local.set({ couchName: name, couchBrokerHost: brokerHost });
  return { name, brokerHost };
}

// ---- Event wiring ----------------------------------------------------------

$('#open-netflix').onclick = () => chrome.tabs.create({ url: 'https://www.netflix.com' });

$('#create').onclick = async () => {
  const { name, brokerHost } = readConfig();
  const resp = await sendToContent({ type: 'create-party', name, brokerHost });
  if (resp) await refresh();
};

$('#join').onclick = async () => {
  const room = $('#join-code').value.trim().toUpperCase();
  if (!room) { $('#join-code').focus(); return; }
  const { name, brokerHost } = readConfig();
  const resp = await sendToContent({ type: 'join-party', room, name, brokerHost });
  if (resp) await refresh();
};

$('#copy').onclick = async () => {
  const code = $('#room-code').textContent;
  await navigator.clipboard.writeText(code);
  $('#copy').textContent = 'Copied!';
  setTimeout(() => ($('#copy').textContent = 'Copy code'), 1200);
};

$('#copy-link').onclick = async () => {
  if (!currentLink) return;
  await navigator.clipboard.writeText(currentLink);
  const btn = $('#copy-link');
  const orig = btn.textContent;
  btn.textContent = '✓ Link copied!';
  setTimeout(() => (btn.textContent = orig), 1400);
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
