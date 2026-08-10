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
globalThis.location = { hash: '#/games', replace(h) { this.hash = h; } };
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
    'viewTeams, viewDay, viewPark, viewSearch, viewAbout, ' +
    'weekdayOf, monthsBetween, dayBucket, setMeta: m => { META = m; }};')();
}

// tiny URLSearchParams stand-in for the query objects the router passes in
function Q(obj) {
  return { get: k => (k in obj ? String(obj[k]) : null) };
}

async function main() {
  const V = loadApp();
  V.setMeta(JSON.parse(readFile(FIX + 'meta.json')));

  const cases = [
    /* The calendar with nothing picked. 1927 ran 12 April to 30 October, so
       the strip is seven months; April starts on a Friday, which puts five
       blanks before the 1st. Neither is asserted here beyond the month names
       -- the arithmetic is checked below, against Retrosheet's own dow. */
    ['games (1927) — calendar', () => V.viewGames([], Q({ season: 1927 })),
      // No day picked, so no game table at all -- the calendar is the page.
      h => h.includes('cal-month') && h.includes('April') && h.includes('October')
        && h.includes('1,275 games in 1927') && h.includes('190 days')
        && !h.includes('table-wrap')],
    ['games (1927) — a day picked', () =>
      V.viewGames([], Q({ season: 1927, date: '1927-07-04' })),
      h => h.includes('July 4, 1927') && h.includes('16 games')
        && h.includes('New York Yankees') && h.includes('aria-current="date"')],
    /* A club turns the counts into results. The 1927 Giants played 155 games
       over 27 doubleheader days and tied one, so this one fixture carries
       every branch of the result cell. */
    ['games (1927) — a club', () => V.viewGames([], Q({ season: 1927, team: 'NY1' })),
      h => h.includes('155 games in 1927') && h.includes('r-W') && h.includes('r-L')
        && h.includes('r-T') && h.includes(' dh') && h.includes('doubleheader')],
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

  // --- the day view is a redirect now, so it renders nothing to assert on
  location.hash = '#/day/1956-10-08';
  await V.viewDay(['1956-10-08']);
  check('day — redirects into the games tab',
    location.hash === '#/games?season=1956&date=1956-10-08', location.hash);

  /* Calendar arithmetic, checked against Retrosheet rather than against
     itself: game.dow is recorded per game in the database, and these are the
     values it holds. This is the guard on the one bug this code is most
     likely to grow -- new Date('1927-07-04') is UTC midnight, so a naive
     implementation puts the 4th of July 1927 on the Sunday. */
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  [['1871-05-04', 'Thu'], ['1927-04-12', 'Tue'], ['1927-07-04', 'Mon'],
   ['1956-10-08', 'Mon'], ['2025-11-01', 'Sat']].forEach(([iso, dow]) => {
    const [y, m, d] = iso.split('-').map(Number);
    check(`${iso} is a ${dow}`, DOW[V.weekdayOf(y, m, d)] === dow,
      DOW[V.weekdayOf(y, m, d)]);
  });

  // 1926's Negro League clubs played winter ball, so its strip is twelve
  // months. A hardcoded April-to-October would drop both ends of it.
  check('1926 spans twelve months',
    V.monthsBetween('1926-01-01', '1926-12-26').length === 12,
    V.monthsBetween('1926-01-01', '1926-12-26').length);
  check('1927 spans seven months',
    V.monthsBetween('1927-04-12', '1927-10-30').length === 7,
    V.monthsBetween('1927-04-12', '1927-10-30').length);
  // 27 games on 18 July 1943 is the busiest day Retrosheet has.
  check('the ramp tops out at 12 and stays there',
    V.dayBucket(12) === 5 && V.dayBucket(27) === 5 && V.dayBucket(1) === 1);

  print('');
  print(failures ? `${failures} of ${checks} failed` : `all ${checks} checks pass`);
  if (failures) throw new Error('view tests failed');
}

main().catch(e => { print('HARNESS ERROR: ' + e); throw e; });
drainMicrotasks();
