/* Prove api-local.js answers the same as app.py.

   There are two implementations of every endpoint — Python over SQLite, and
   JavaScript over the exported JSON — and the whole point of api-local.js is
   that app.js cannot tell them apart. Nothing enforces that but this file.

   The fixtures in fixtures/ are recorded from a live app.py by test_views.sh.
   Here api-local.js runs in JavaScriptCore against the real docs/data exports,
   and the answers are compared field by field.

   Run:  ./test_views.sh          (which runs this after the view tests) */
'use strict';

let failures = 0, checks = 0;

// ------------------------------------------------------- browser stand-ins

globalThis.window = {};
globalThis.URLSearchParams = class {
  constructor(init) {
    this.m = new Map();
    if (typeof init === 'string') {
      init.replace(/^\?/, '').split('&').filter(Boolean).forEach(kv => {
        const [k, v] = kv.split('=');
        this.m.set(decodeURIComponent(k), decodeURIComponent(v || ''));
      });
    }
  }
  get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  set(k, v) { this.m.set(k, String(v)); }
  toString() { return [...this.m].map(([k, v]) => k + '=' + v).join('&'); }
};

// fetch('data/...') reads the real export off disk
globalThis.fetch = async function (url) {
  const path = 'docs/' + url;
  try {
    const body = readFile(path);
    return { ok: true, json: async () => JSON.parse(body) };
  } catch (e) {
    return { ok: false, json: async () => { throw new Error('missing ' + path); } };
  }
};

// --------------------------------------------------------------- comparison

function get(o, path) {
  return path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
}

function eq(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  // app.py returns numbers; JSON round-trips them the same, but be forgiving
  // about number-vs-numeric-string rather than fail on a formatting detail
  if (a != null && b != null && String(a) === String(b)) return true;
  return false;
}

function compare(label, mine, theirs, paths) {
  const bad = [];
  for (const p of paths) {
    const a = get(mine, p), b = get(theirs, p);
    if (!eq(a, b)) bad.push(`${p}: local=${JSON.stringify(a)} app.py=${JSON.stringify(b)}`);
  }
  checks++;
  if (bad.length) {
    failures++;
    print('  FAIL  ' + label);
    bad.slice(0, 6).forEach(x => print('          ' + x));
  } else {
    print('  ok    ' + label + '  (' + paths.length + ' fields)');
  }
}

const fixture = name => JSON.parse(readFile('fixtures/' + name + '.json'));

// build the list of field paths to check for a list of rows
function rowPaths(prefix, n, keys) {
  const out = [];
  for (let i = 0; i < n; i++) for (const k of keys) out.push(`${prefix}.${i}.${k}`);
  return out;
}

async function main() {
  const src = readFile('static/api-local.js');
  new Function(src)();
  const API = globalThis.window.LocalAPI;

  // --- meta
  compare('/meta', await API.get('/meta'), fixture('meta'),
    ['firstSeason', 'lastSeason', 'games', 'withBox', 'withPlays']);

  // --- search: same people, same order, same ranking
  compare('/search?q=ruth', await API.get('/search?q=ruth'), fixture('search_q_ruth'),
    rowPaths('results', 8, ['id', 'name', 'hof', 'debut', 'lastGame', 'games']));

  // --- a game: the box score, name resolution and the itemised events
  const gid = 'NYA195610080';
  compare(`/game/${gid}`, await API.get('/game/' + gid), fixture('game_NYA195610080'),
    ['game.visName', 'game.homeName', 'game.vis_score', 'game.home_score',
     'game.gametypeLabel', 'game.attendance', 'game.duration', 'game.v_h', 'game.h_e',
     'game.visLine.0', 'game.homeLine.3', 'park.name',
     'people.wp', 'people.lp', 'people.ump_hp', 'people.mgr_home',
     ...rowPaths('batting', 10, ['person', 'name', 'side', 'ab', 'r', 'h', 'rbi',
                                 'bb', 'so', 'hr', 'positions.0', 'pinchHitInning']),
     ...rowPaths('pitching', 2, ['person', 'name', 'outs', 'h', 'bb', 'so', 'er', 'bfp']),
     ...rowPaths('events', 3, ['kind', 'side', 'inning', 'playerNames.0'])]);

  // --- a career: every season row and the fielding breakdown
  compare('/player/ruthb101', await API.get('/player/ruthb101'), fixture('player_ruthb101'),
    ['person.name', 'person.hof', 'person.bats', 'person.throws', 'person.height',
     'person.weight', 'person.birthdate', 'person.birth_city', 'person.birth_country',
     'person.deathdate', 'person.play_debut', 'person.play_last',
     'seasons.0', 'seasons.10',
     ...rowPaths('batting', 22, ['season', 'team', 'teamName', 'gametype', 'g', 'ab',
                                 'r', 'h', 'hr', 'rbi', 'bb', 'so', 'sb']),
     ...rowPaths('pitching', 10, ['season', 'team', 'g', 'outs', 'h', 'er', 'so']),
     ...rowPaths('fielding', 12, ['season', 'gametype', 'pos', 'position', 'g',
                                  'po', 'a', 'e'])]);

  // --- a game log
  compare('/player/ruthb101/games?season=1927',
    await API.get('/player/ruthb101/games?season=1927'),
    fixture('player_ruthb101_games_season_1927'),
    ['total', ...rowPaths('games', 20, ['id', 'date', 'team', 'teamName', 'opp',
                                        'oppName', 'side', 'ab', 'r', 'h', 'hr',
                                        'rbi', 'vis_score', 'home_score'])]);

  // --- a season: the running record is the thing most likely to drift
  compare('/team/NYA?season=1927', await API.get('/team/NYA?season=1927'),
    fixture('team_NYA_season_1927'),
    ['record.w', 'record.l', 'record.t', 'records.regular.w', 'records.regular.label',
     'records.worldseries.w', 'records.worldseries.l',
     'info.city', 'info.nickname', 'info.league',
     ...rowPaths('games', 30, ['id', 'date', 'opp', 'oppName', 'us', 'them',
                               'result', 'record', 'atHome']),
     ...rowPaths('roster', 20, ['person', 'name', 'pos', 'bats', 'throws'])]);

  // --- season list for a club
  compare('/team/NYA', await API.get('/team/NYA'), fixture('team_NYA'),
    rowPaths('seasons', 20, ['season', 'n']));

  /* --- the game finder, in the three shapes viewGames asks for it in.

     The calendar is the half most likely to drift, because app.py builds it
     with a GROUP BY and api-local.js builds it with a loop over the shard.
     The counts are compared day by day, and with a club chosen so are the
     W/L/T strings -- which is also the only place either implementation has
     to agree about the order two games of a doubleheader were played in. */
  const days = (n, keys) => rowPaths('days', n, keys);

  /* The third field is compared even here, where neither side should have
     one: `undefined + ''` is the string "undefined", so a day of two games
     is exactly where a results field grows that nobody asked for. Comparing
     only [0] and [1] let that through once already. */
  compare('/games?season=1927 (calendar only)',
    await API.get('/games?season=1927&limit=0'),
    fixture('games_season_1927_limit_0'),
    ['total', 'shown', 'days.length', ...days(60, ['0', '1', '2'])]);

  compare('/games?season=1927&team=NY1 (results + list)',
    await API.get('/games?season=1927&limit=400&team=NY1'),
    fixture('games_season_1927_limit_400_team_NY1'),
    ['total', 'shown', 'days.length', ...days(60, ['0', '1', '2']),
     ...rowPaths('games', 30, ['id', 'date', 'number', 'vis', 'home', 'visName',
       'homeName', 'vis_score', 'home_score', 'parkName'])]);

  compare('/games?season=1927&gametype=worldseries',
    await API.get('/games?season=1927&limit=400&gametype=worldseries'),
    fixture('games_season_1927_limit_400_gametype_worldseries'),
    ['total', 'shown', 'days.length', ...days(8, ['0', '1', '2']),
     ...rowPaths('games', 4, ['id', 'date', 'visName', 'homeName',
       'vis_score', 'home_score', 'parkName', 'attendance'])]);

  compare('/games?season=1927&date=1927-07-04',
    await API.get('/games?season=1927&limit=400&date=1927-07-04'),
    fixture('games_season_1927_limit_400_date_1927-07-04'),
    ['total', 'shown', 'days.length',
     ...rowPaths('games', 16, ['id', 'date', 'vis', 'home', 'visName', 'homeName',
       'vis_score', 'home_score', 'parkName', 'attendance', 'has_box', 'has_pbp'])]);

  /* The regression this design is most exposed to: `date` narrows the games
     but must not narrow the calendar, or picking a day destroys the control
     the reader picked it with. 1927 played on 154 days either way. */
  const picked = await API.get('/games?season=1927&limit=400&date=1927-07-04');
  const whole = await API.get('/games?season=1927&limit=0');
  compare('picking a day leaves the calendar whole',
    { n: picked.days.length }, { n: whole.days.length }, ['n']);

  // --- a park
  compare('/park/NYC16', await API.get('/park/NYC16'), fixture('park_NYC16'),
    ['park.name', 'park.city', 'park.state', 'span.a', 'span.b', 'span.n',
     ...rowPaths('bySeason', 20, ['season', 'n', 'avg_att'])]);

  // --- teams in a season
  compare('/teams?season=1927', await API.get('/teams?season=1927'),
    fixture('teams_season_1927'),
    rowPaths('teams', 20, ['id', 'league', 'city', 'nickname', 'n', 'allstar']));

  print('');
  print(failures
    ? `${failures} of ${checks} endpoints disagree with app.py`
    : `all ${checks} endpoints agree with app.py`);
  if (failures) throw new Error('local API disagrees with app.py');
}

main().catch(e => { print('HARNESS ERROR: ' + e); throw e; });
drainMicrotasks();
