/*
 * Harness for injected.js: a minimal DOM that reproduces the two Prime Video
 * failure modes Saurabh hit. No browser, no network - just enough of document /
 * window for the script to run, so we can assert on the messages it posts.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ---- fake DOM ---------------------------------------------------------------

class FakeVideo {
  constructor(opts = {}) {
    this.tagName = 'VIDEO';
    this.paused = opts.paused !== undefined ? opts.paused : true;
    this.ended = false;
    this.muted = !!opts.muted;
    this.readyState = opts.readyState !== undefined ? opts.readyState : 4;
    this.currentTime = opts.currentTime || 0;
    this.duration = opts.duration !== undefined ? opts.duration : 7200; // 2h
    this._w = opts.w !== undefined ? opts.w : 1280;
    this._h = opts.h !== undefined ? opts.h : 720;
    this.label = opts.label || 'video';
    // The pre-fix script binds handlers straight to the element, the fixed one
    // listens on document in the capture phase. Support both so the same tests
    // can be run against either version.
    this._own = { play: [], pause: [], seeked: [] };
  }
  addEventListener(type, fn) { (this._own[type] || []).push(fn); }
  getBoundingClientRect() { return { width: this._w, height: this._h }; }
  play() { this.paused = false; dispatch('play', this); return Promise.resolve(); }
  pause() { this.paused = true; dispatch('pause', this); }
}

class FakeEl {
  constructor(h) { this._h = h; }
  getBoundingClientRect() { return { width: 200, height: this._h }; }
}

const dom = {
  videos: [],
  adEl: null,          // set to a FakeEl to simulate an ad badge being rendered
};

const docListeners = { play: [], pause: [], seeked: [] };

function dispatch(type, target) {
  // Element-bound handlers (old style) then document capture (new style).
  (target._own && target._own[type] || []).forEach((fn) => fn({ target }));
  (docListeners[type] || []).forEach((fn) => fn({ target }));
}

global.document = {
  querySelectorAll: (sel) => (sel === 'video' ? dom.videos : []),
  querySelector: (sel) => {
    if (sel === 'video') return dom.videos[0] || null;
    // Any of the ad selectors resolves to the ad element when one is present.
    if (dom.adEl && /ad/i.test(sel)) return dom.adEl;
    return null;
  },
  addEventListener: (type, fn, capture) => {
    if (capture && docListeners[type]) docListeners[type].push(fn);
  },
};

const posted = [];
global.window = {
  __couchInjected: undefined,
  postMessage: (msg) => posted.push(msg),
  addEventListener: () => {},
  netflix: undefined,
};
// injected.js reads bare `window.__couchInjected` etc.
global.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
global.clearInterval = () => {};
const timers = [];
function tick() { timers.forEach((t) => t.fn()); }

// ---- load the real script ---------------------------------------------------

const src = fs.readFileSync(
  path.join(__dirname, '../extension/src/injected.js'), 'utf8');
// The script is an IIFE that closes over the globals we just defined.
eval(src);

// ---- assertions -------------------------------------------------------------

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); }
  else { failures++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function lastOfType(type) {
  for (let i = posted.length - 1; i >= 0; i--) if (posted[i].type === type) return posted[i];
  return null;
}

console.log('\n1. Picking the right <video> on a Prime-style page');
console.log('   (DOM order: hidden preview first, real player second)');
// This is the exact shape that broke it: a zero-size leftover/preview element
// sits first in the DOM, so querySelector('video') returns the wrong one.
const preview = new FakeVideo({ label: 'preview', w: 0, h: 0, paused: true, muted: true });
const player  = new FakeVideo({ label: 'player', paused: false, currentTime: 1800 });
dom.videos = [preview, player];
tick();  // let the ready/ad pollers run once

check('old behaviour would have picked the preview',
      dom.videos[0].label === 'preview');

// Now the user pauses the REAL player.
posted.length = 0;
player.pause();
const st = lastOfType('state');
check('pause on the real player emits a state message', !!st,
      'no state message was posted');
check('  ...with action "pause"', st && st.action === 'pause', st && st.action);
check('  ...reporting paused=true', st && st.paused === true, st && String(st.paused));
check('  ...at the content position (1800s)', st && st.timeMs === 1800000,
      st && String(st.timeMs));

console.log('\n2. Events from the wrong element are ignored');
posted.length = 0;
preview.play();          // a trailer autoplaying must not drive the party
check('preview play() emits nothing', lastOfType('state') === null,
      JSON.stringify(lastOfType('state')));

console.log('\n3. Ad break: detection, freeze, and resume');
player.paused = false;
player.currentTime = 1900;
tick();                                    // content clock warms to 1900s
posted.length = 0;
dom.adEl = new FakeEl(40);                 // Prime renders its ad timer
player.currentTime = 7;                    // player clock is now the AD's
tick();
const adOn = lastOfType('ad');
check('entering an ad emits ad:true', adOn && adOn.inAd === true, JSON.stringify(adOn));
check('  ...freezing the CONTENT time, not the ad time (1900s)',
      adOn && adOn.timeMs === 1900000, adOn && String(adOn.timeMs));

posted.length = 0;
player.pause();                            // ad creative pauses/ends
check('no state leaks out during the ad', lastOfType('state') === null,
      JSON.stringify(lastOfType('state')));

dom.adEl = null;                           // ad over, content resumes
player.paused = false;
player.currentTime = 1900;
tick();
const adOff = lastOfType('ad');
check('leaving an ad emits ad:false', adOff && adOff.inAd === false, JSON.stringify(adOff));
check('  ...with the resume position (1900s)',
      adOff && adOff.timeMs === 1900000, adOff && String(adOff.timeMs));

console.log('\n4. Ad detected by duration collapse alone (no ad DOM)');
posted.length = 0;
player.duration = 20;                      // a 20s creative after a 2h feature
tick();
const adDur = lastOfType('ad');
check('short duration after long content reads as an ad',
      adDur && adDur.inAd === true, JSON.stringify(adDur));

console.log(failures === 0
  ? '\nAll checks passed.\n'
  : '\n' + failures + ' check(s) FAILED.\n');
process.exit(failures === 0 ? 0 : 1);
