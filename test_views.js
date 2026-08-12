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
    'weekdayOf, monthsBetween, dayBucket, gamesHash, setMeta: m => { META = m; }};')();
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
    /* Regular season is not a narrowing. It is 1,236 of 1927's 1,275 games --
       the rest being 35 Negro League games and a four-game World Series -- so
       it gets the same calendar-only treatment as Any. Listing it would be
       listing the season, which is what this tab was built to stop doing. */
    ['games (1927) — regular season only', () =>
      V.viewGames([], Q({ season: 1927, gametype: 'regular' })),
      h => h.includes('cal-month') && h.includes('1,236 games in 1927')
        && !h.includes('table-wrap')],
    /* A park narrows like a club does, and unlike a club it has no select,
       so the view has to name it and offer a way off it. */
    ['games (1927) — a park', () =>
      V.viewGames([], Q({ season: 1927, park: 'NYC16' })),
      h => h.includes('Yankee Stadium') && h.includes('class="parkfilter"')
        && h.includes('Remove the park filter') && h.includes('table-wrap')],
    /* The reported state, exactly: a park carried out of its own season.
       Bloomsburg Fair Grounds played host in 1926 and never again, so 1985
       matches nothing -- and the view has to name the park it could find no
       games for, say "0 games" once rather than twice, and offer the cross. */
    ['games (1985) — a park with no games that season', () =>
      V.viewGames([], Q({ season: 1985, team: 'BAL', park: 'BLO01' })),
      h => h.includes('Bloomsburg Fair Grounds') && h.includes('0 games in 1985')
        && h.includes('Remove the park filter')
        && (h.match(/No games match those filters/g) || []).length === 1],
    ['games (1927) — a day picked', () =>
      V.viewGames([], Q({ season: 1927, date: '1927-07-04' })),
      h => h.includes('July 4, 1927') && h.includes('16 games')
        && h.includes('New York Yankees') && h.includes('aria-current="date"')],
    /* A club turns the counts into results, and is narrow enough to list under
       the calendar. The 1927 Giants played 155 games over 27 doubleheader days
       and tied one, so this one fixture carries every branch of the result
       cell. The list keeps its Date column, because these rows span a season
       rather than an afternoon. */
    ['games (1927) — a club', () => V.viewGames([], Q({ season: 1927, team: 'NY1' })),
      h => h.includes('155 games in 1927') && h.includes('r-W') && h.includes('r-L')
        && h.includes('r-T') && h.includes(' dh') && h.includes('doubleheader')
        && h.includes('table-wrap') && h.includes('>Date<')
        // The date picks the day and keeps the club; the button opens the game.
        && h.includes('href="#/games?season=1927&team=NY1&date=1927-')
        && h.includes('<a class="pill" href="#/game/')],
    /* 1871 has no box scores at all -- Retrosheet knows the game happened and
       who won, and nothing about who played. The button says so and stays a
       link, because that page still carries the result and the park. */
    ['games (1871) — a day with no box scores', () =>
      V.viewGames([], Q({ season: 1871, date: '1871-05-04' })),
      h => h.includes('May 4, 1871')
        && h.includes('<a class="pill quiet" href="#/game/FW1187105040')
        && h.includes('>game</a>') && !h.includes('>box</a>')],
    /* A round other than the regular season is narrow too. 1927's was a sweep,
       so this is four rows -- and the type filter, unlike the club, leaves the
       calendar in count mode. */
    ['games (1927) — World Series', () =>
      V.viewGames([], Q({ season: 1927, gametype: 'worldseries' })),
      h => h.includes('4 games in 1927') && h.includes('table-wrap')
        && h.includes('Pittsburgh Pirates') && !h.includes('r-W')],
    /* A league is not a kind of game. 1933 had two competitions running at
       once, and the calendar used to blend them into the same day cells while
       Type offered "Negro Leagues" beside "World Series" as alternatives. */
    ['games (1933) — the league control appears', () =>
      V.viewGames([], Q({ season: 1933 })),
      h => h.includes('id="f-league"') && h.includes('Major Leagues')
        && h.includes('Negro National League II')],
    ['games (2024) — and stays away when there is one league', () =>
      V.viewGames([], Q({ season: 2024 })),
      h => !h.includes('id="f-league"')],
    /* 170 games, narrow enough to list -- and the Major Leagues are not a
       narrowing, being the season itself. */
    ['games (1933) — a Negro League is a narrowing', () =>
      V.viewGames([], Q({ season: 1933, league: 'NN2' })),
      h => h.includes('id="f-league"') && h.includes('table-wrap')],
    ['game — Larsen perfect game', () => V.viewGame(['NYA195610080']),
      h => h.includes('Don Larsen') && h.includes('linescore') && h.includes('Yankee Stadium')],
    /* Maldonado hit two, in the 7th and the 9th. He is named once with the
       count and both accounts, not twice as though they were separate men --
       and the runners aboard appear at all, which they had never done. */
    ['game — two home runs by one man read as one entry', () =>
      V.viewGame(['LAN198610050']),
      h => h.includes('Maldonado 2 (7th off Hershiser, 3 on, 9th off Galvez, 1 on)')
        && h.includes('Melvin (8th off Galvez, 1 on)')],
    ['player — Ruth, no season', () => V.viewPlayer(['ruthb101'], Q({})),
      h => h.includes('Babe Ruth') && h.includes('Batting') && h.includes('Career')
        // He pitched, so the decisions have to reach the table: 94-46 lifetime.
        && h.includes('>OPS<') && h.includes('>SHO<')
        // 15 World Series home runs are his record too, and they used to be
        // filtered out of every table on the page.
        && h.includes('World Series')],
    /* The log is its own page now, reached from the picker under the bio. */
    ['player — Ruth, 1927 log', () => V.viewPlayer(['ruthb101', 'games'], Q({ season: 1927 })),
      h => h.includes('1927 game log') && h.includes('← Babe Ruth')
        && h.includes('href="#/player/ruthb101"')],
    /* Every one of his 741 games is gametype 'negro', so a page that showed
       the regular season alone showed him nothing at all. 971 hits and 188
       home runs: it was 633 and 116 until the summer 2026 release put the
       1933 and 1934 seasons back in the middle of his prime. */
    ['player — Josh Gibson, Negro Leagues only', () => V.viewPlayer(['gibsj101'], Q({})),
      h => h.includes('Josh Gibson') && h.includes('Negro Leagues')
        && h.includes('>971<') && h.includes('>188<')],
    /* A pitcher's line is read for W-L-ERA before anything else, and none of
       the six are in Retrosheet's box score -- 1913 is 36-7, 36 GS, 29 CG,
       11 SHO. */
    ['player — Walter Johnson, decisions', () => V.viewPlayer(['johnw102'], Q({})),
      h => h.includes('Walter Johnson') && h.includes('>417<') && h.includes('>110<')],
    /* 2,709 people in the database never played a game, and their pages used
       to be a name and a birthplace. Lasorda pitched for three seasons and
       managed for twenty-one, so he gets both records and both game logs. */
    ['player — Lasorda, managing record', () => V.viewPlayer(['lasot101'], Q({})),
      // 1,598-1,437 with two ties, and the bio line for the years he coached.
      h => h.includes('Tom Lasorda') && h.includes('Managing')
        && h.includes('>1598<') && h.includes('>1437<') && h.includes('Coached')
        // He pitched in 1954-56, so the playing tables are there too.
        && h.includes('Pitching')],
    /* 162 regular-season games, four in the LCS and six in the World Series.
       Totalled together that is 103-69; split, the regular season reads the
       98-64 he is credited with. */
    ['player — Lasorda, 1977 managed log', () =>
      V.viewPlayer(['lasot101', 'games'], Q({ season: 1977 })),
      h => h.includes('172 games in 1977') && h.includes('98–64')
        && h.includes('World Series') && !h.includes('103–69')
        && h.includes('← Tom Lasorda')],
    ['player — Klem, umpiring record', () => V.viewPlayer(['klemb901'], Q({})),
      // 5,369 regular-season games, 3,544 of them behind the plate.
      h => h.includes('Bill Klem') && h.includes('Umpiring')
        && h.includes('Umpired') && h.includes('>5369<') && h.includes('>3544<')
        // Never played, so no batting, pitching or fielding table at all.
        && !h.includes('>AVG<') && !h.includes('>ERA<')],
    /* Crews were two men in 1905, so the plate and first base carry the
       season and second and third stay empty. */
    ['player — Klem, 1905 umpired log', () =>
      V.viewPlayer(['klemb901', 'games'], Q({ season: 1905 })),
      h => h.includes('151 games in 1905') && h.includes('>HP<')],
    /* The picker sits under the bio and above the season tables, and the old
       ?season= address still lands on the log rather than on a player page
       with the season quietly dropped. */
    ['player — the log picker leads the tables', () => V.viewPlayer(['ruthb101'], Q({})),
      h => h.indexOf('Game log') < h.indexOf('Batting')
        && h.includes('id="gl-season"')],
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

  /* The log moved out of the player page and onto one of its own. The address
     it used to live at still reaches it, so a bookmark or an old link lands on
     the log rather than on a player page with the season quietly dropped. */
  location.hash = '#/player/ruthb101?season=1927';
  await V.viewPlayer(['ruthb101'], Q({ season: 1927 }));
  check('player — the old ?season= address redirects to the log page',
    location.hash === '#/player/ruthb101/games?season=1927', location.hash);

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

  /* The day and the park are season-scoped, and BLO01 is why. Bloomsburg
     Fair Grounds hosted three Negro League games, all of them in 1926, and
     has never held another. Carried out of 1926 -- as it was, silently, with
     no control naming it and no way to switch it off -- it answers every
     other year with "0 games" while Club and Type both read wide open. */
  const held = { season: 1926, park: 'BLO01', date: '1926-09-19' };
  check('a change of season drops the park and the day',
    V.gamesHash({ ...held, season: 1985, was: 1926 }) === '#/games?season=1985',
    V.gamesHash({ ...held, season: 1985, was: 1926 }));
  check('staying in the season keeps them',
    V.gamesHash({ ...held, was: 1926 })
      === '#/games?season=1926&park=BLO01&date=1926-09-19',
    V.gamesHash({ ...held, was: 1926 }));
  // The cross beside the park: the same query, minus the park.
  check('the park can be taken off',
    V.gamesHash({ season: 1926, date: '1926-09-19' })
      === '#/games?season=1926&date=1926-09-19');
  // No `was` means no change of season is in play -- a calendar click, say.
  check('a day can be set without the park being dropped',
    V.gamesHash({ season: 1926, park: 'BLO01', date: '1926-09-20' })
      === '#/games?season=1926&park=BLO01&date=1926-09-20');
  // A club survives a change of season; only the two season-scoped ones go.
  check('a club is not season-scoped',
    V.gamesHash({ season: 1985, team: 'BAL', park: 'BLO01', was: 1926 })
      === '#/games?season=1985&team=BAL');

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
