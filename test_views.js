/* Drive every view against recorded API responses, in JavaScriptCore.
   There is no browser on this machine and no build step in this project, so
   this is the substitute for clicking through: it proves each view renders
   without throwing and produces the markup it claims to.

   Run:  ./test_views.sh          (captures fresh fixtures, then runs this) */
'use strict';

const FIX = 'fixtures/';
let failures = 0, checks = 0;

// ------------------------------------------------------------- minimal DOM

function El(id) {
  return {
    id, innerHTML: '', textContent: '', value: '',
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
    getAttribute() { return null; },
  };
}
const elements = {};
const el = id => (elements[id] = elements[id] || El(id));

globalThis.document = {
  getElementById: el,
  querySelectorAll: () => [],
};
globalThis.window = { scrollTo() {}, addEventListener() {} };
globalThis.location = { hash: '#/games' };
globalThis.encodeURIComponent = globalThis.encodeURIComponent || (s => s);

// jsc has no URLSearchParams; the views only ever set, read and stringify.
globalThis.URLSearchParams = class {
  constructor(init) {
    this.m = new Map();
    if (typeof init === 'string') {
      init.replace(/^\?/, '').split('&').filter(Boolean).forEach(kv => {
        const [k, v] = kv.split('=');
        this.m.set(decodeURIComponent(k), decodeURIComponent(v || ''));
      });
    } else if (init) {
      Object.entries(init).forEach(([k, v]) => this.m.set(k, String(v)));
    }
  }
  get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  set(k, v) { this.m.set(k, String(v)); }
  toString() {
    return [...this.m].map(([k, v]) =>
      encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  }
};

globalThis.fetch = async function (url) {
  const name = url.replace(/^\/api\//, '').replace(/[\/?&=]/g, '_');
  let body;
  try {
    body = readFile(FIX + name + '.json');
  } catch (e) {
    throw new Error('no fixture for ' + url + ' (wanted ' + name + '.json)');
  }
  return { ok: true, json: async () => JSON.parse(body) };
};

// ------------------------------------------------------------------ harness

function check(label, cond, detail) {
  checks++;
  if (!cond) { failures++; print('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
  else print('  ok    ' + label);
}

function loadApp() {
  const src = readFile('static/app.js');
  // The file ends in a boot IIFE that fetches /meta and installs a hashchange
  // listener; strip it so the harness can drive the views directly.
  const cut = src.indexOf('// --------------------------------------------------------------------- boot');
  const body = src.slice(0, cut);
  return new Function(body + '\nreturn {viewGames, viewGame, viewPlayer, viewTeam, ' +
    'viewTeams, viewDay, viewPark, viewSearch, viewAbout, setMeta: m => { META = m; }};')();
}

// tiny URLSearchParams stand-in for the query objects the router passes in
function Q(obj) {
  return { get: k => (k in obj ? String(obj[k]) : null) };
}

async function main() {
  const V = loadApp();
  V.setMeta(JSON.parse(readFile(FIX + 'meta.json')));

  const cases = [
    ['games (1927)', () => V.viewGames([], Q({ season: 1927 })),
      h => h.includes('games') && h.includes('New York Yankees')],
    ['game — Larsen perfect game', () => V.viewGame(['NYA195610080']),
      h => h.includes('Don Larsen') && h.includes('linescore') && h.includes('Yankee Stadium')],
    ['player — Ruth, no season', () => V.viewPlayer(['ruthb101'], Q({})),
      h => h.includes('Babe Ruth') && h.includes('Batting') && h.includes('Career')],
    ['player — Ruth, 1927 log', () => V.viewPlayer(['ruthb101'], Q({ season: 1927 })),
      h => h.includes('Babe Ruth')],
    ['team — 1927 Yankees', () => V.viewTeam(['NYA'], Q({ season: 1927 })),
      h => h.includes('Schedule') && h.includes('Roster') && h.includes('110')],
    ['team — season list', () => V.viewTeam(['NYA'], Q({})), h => h.includes('Season')],
    ['teams — 1927', () => V.viewTeams([], Q({ season: 1927 })), h => h.includes('Clubs in 1927')],
    ['day — 1956-10-08', () => V.viewDay(['1956-10-08']), h => h.includes('October 8, 1956')],
    ['park — Yankee Stadium', () => V.viewPark(['NYC16']), h => h.includes('Games')],
    ['search — ruth', () => V.viewSearch([], Q({ q: 'ruth' })), h => h.includes('Babe Ruth')],
    ['about', () => V.viewAbout(), h => h.includes('Retrosheet')],
  ];

  for (const [label, run, assert] of cases) {
    // Clear in place, never replace: app.js captures document.getElementById('app')
    // once at load, so swapping the object leaves the views writing to an orphan.
    ['app', 'gamelog', 'results'].forEach(id => { el(id).innerHTML = ''; });
    try {
      await run();
      drainMicrotasks();
      const html = (elements.app.innerHTML || '') + (elements.gamelog.innerHTML || '')
        + (elements.results.innerHTML || '');
      if (!html) check(label, false, 'rendered nothing');
      else if (!assert(html)) check(label, false, 'markup missing expected content');
      else check(label, true);
    } catch (e) {
      check(label, false, String(e) + (e.stack ? '\n        ' + e.stack.split('\n')[0] : ''));
    }
  }

  print('');
  print(failures ? `${failures} of ${checks} failed` : `all ${checks} views render`);
  if (failures) throw new Error('view tests failed');
}

main().catch(e => { print('HARNESS ERROR: ' + e); throw e; });
drainMicrotasks();
