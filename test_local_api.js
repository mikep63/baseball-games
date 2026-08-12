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
/* jsc has no DecompressionStream, so api-local's inflate path cannot run here.
   The shards the test reads are inflated by test_views.sh instead, and this
   stands in for the streaming API over the already-plain bytes. */
globalThis.DecompressionStream = function () { this.plain = true; };
globalThis.Response = function (body) { this._b = body; };
globalThis.Response.prototype.text = async function () { return this._b; };
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
  // The play shards are gzipped in docs/; test_views.sh inflates the ones this
  // reads into .plays-inflated first, because jsc cannot.
  const m = url.match(/^data\/plays\/(.+)\.json\.gz$/);
  const path = m ? '.plays-inflated/' + m[1] + '.json' : 'docs/' + url;
  try {
    const body = readFile(path);
    // `body` here stands in for the response stream api-local pipes through
    // DecompressionStream; inflated already, the pipe is the identity.
    return { ok: true, json: async () => JSON.parse(body),
             body: { pipeThrough: () => body } };
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
     // Larsen's perfect game had a six-man crew. The export carried four of
     // them for as long as it existed, and this line is why that went unseen.
     'people.wp', 'people.lp', 'people.ump_hp', 'people.ump_1b', 'people.ump_2b',
     'people.ump_3b', 'people.ump_lf', 'people.ump_rf',
     'people.mgr_vis', 'people.mgr_home',
     ...rowPaths('batting', 10, ['person', 'name', 'side', 'ab', 'r', 'h', 'rbi',
                                 'bb', 'so', 'hr', 'positions.0', 'pinchHitInning']),
     ...rowPaths('pitching', 2, ['person', 'name', 'outs', 'h', 'bb', 'so', 'er', 'bfp']),
     // runners_on is displayed now, so it is compared now.
     ...rowPaths('events', 3, ['kind', 'side', 'inning', 'runners_on',
                               'playerNames.0'])]);

  /* The league filter matches either side, so a game across two leagues is
     under both. Nothing else enforces that the two backends agree on it. */
  compare('/games?season=1933&league=NN2',
    await API.get('/games?season=1933&limit=400&league=NN2'),
    fixture('games_season_1933_limit_400_league_NN2'),
    ['total', ...rowPaths('games', 12, ['id', 'date', 'vis', 'home', 'visName',
                                        'homeName', 'gametype'])]);
  compare('/games?season=1920&league=NN1',
    await API.get('/games?season=1920&limit=400&league=NN1'),
    fixture('games_season_1920_limit_400_league_NN1'),
    ['total', ...rowPaths('games', 3, ['id', 'date', 'vis', 'home'])]);
  /* The St. Louis Giants met the Cardinals seven times in 1920-21, so they are
     in the Major Leagues' club list as well as their own. */
  compare('/teams?season=1920&league=MLB',
    await API.get('/teams?season=1920&league=MLB'),
    fixture('teams_season_1920_league_MLB'),
    rowPaths('teams', 17, ['id', 'league', 'city', 'nickname', 'n']));
  compare('/teams?season=1933&league=NN2',
    await API.get('/teams?season=1933&league=NN2'),
    fixture('teams_season_1933_league_NN2'),
    rowPaths('teams', 8, ['id', 'league', 'city', 'nickname', 'n']));

  /* The play-by-play. app.py reads it from SQLite, api-local from a gzipped
     shard it inflates -- two entirely different paths to the same 57 plays. */
  /* The substitutions travel differently in the two backings -- app.py joins a
     table on the play's seq, api-local reads a column riding on the play row
     -- so they are checked at the play they belong to. Larsen's is the 56th,
     the pinch hitter who made the last out of the perfect game; the empty list
     on the 1st play matters as much, because "no subs here" is a claim both
     have to make the same way. */
  compare('/game/NYA195610080/plays',
    await API.get('/game/NYA195610080/plays'),
    fixture('game_NYA195610080_plays'),
    ['total', ...rowPaths('plays', 20, ['seq', 'inning', 'side', 'batter',
                                        'batterName', 'count', 'event']),
     'plays.0.subs.length', 'plays.55.subs.length', 'plays.55.event',
     'plays.55.subs.0.person', 'plays.55.subs.0.pos', 'plays.55.subs.0.name',
     'plays.55.subs.0.side']);
  compare('/game/LAN198610050/plays',
    await API.get('/game/LAN198610050/plays'),
    fixture('game_LAN198610050_plays'),
    ['total', ...rowPaths('plays', 12, ['seq', 'inning', 'side', 'batter',
                                        'event']),
     // Ten changes in this one, from Spilman at first to Valenzuela pitching.
     'plays.3.subs.0.person', 'plays.3.subs.0.pos', 'plays.3.subs.0.name',
     'plays.53.subs.0.person', 'plays.53.subs.0.pos', 'plays.53.subs.0.side',
     'plays.86.subs.0.person', 'plays.86.subs.0.pos', 'plays.86.subs.0.side']);

  // --- a career: every season row and the fielding breakdown
  compare('/player/ruthb101', await API.get('/player/ruthb101'), fixture('player_ruthb101'),
    ['person.name', 'person.hof', 'person.bats', 'person.throws', 'person.height',
     'person.weight', 'person.birthdate', 'person.birth_city', 'person.birth_country',
     'person.deathdate', 'person.play_debut', 'person.play_last',
     'seasons.0', 'seasons.10',
     ...rowPaths('batting', 22, ['season', 'team', 'teamName', 'gametype', 'g', 'ab',
                                 'r', 'h', 'hr', 'rbi', 'bb', 'so', 'sb', 'cs',
                                 'hbp', 'sh', 'sf', 'gidp']),
     // W, L, SV, GS, CG and SHO are derived rather than summed -- app.py works
     // them out per request and build_site.py precomputes them for everyone at
     // once, which is exactly the shape of disagreement this file exists for.
     ...rowPaths('pitching', 10, ['season', 'team', 'g', 'outs', 'h', 'er', 'so',
                                  'bfp', 'hbp', 'wp', 'w', 'l', 'sv', 'gs', 'cg',
                                  'sho']),
     ...rowPaths('fielding', 12, ['season', 'gametype', 'pos', 'position', 'g',
                                  'po', 'a', 'e', 'dp', 'tp', 'pb'])]);

  // --- the two roles that are not playing. 2,709 people have no batting line
  // at all, and these are the only records their pages can show.
  compare('/player/lasot101', await API.get('/player/lasot101'),
    fixture('player_lasot101'),
    ['person.name', 'person.mgr_debut', 'person.mgr_last', 'seasons.0',
     ...rowPaths('managing', 24, ['season', 'team', 'teamName', 'gametype',
                                  'g', 'w', 'l', 't'])]);
  compare('/player/lasot101/games?season=1977',
    await API.get('/player/lasot101/games?season=1977'),
    fixture('player_lasot101_games_season_1977'),
    ['total', ...rowPaths('managed', 20, ['id', 'date', 'team', 'teamName',
                                          'opp', 'oppName', 'side', 'result',
                                          'vis_score', 'home_score'])]);
  compare('/player/klemb901', await API.get('/player/klemb901'),
    fixture('player_klemb901'),
    ['person.name', 'person.ump_debut', 'person.ump_last',
     ...rowPaths('umpiring', 30, ['season', 'gametype', 'g', 'hp', 'b1', 'b2',
                                  'b3', 'lf', 'rf'])]);
  compare('/player/klemb901/games?season=1905',
    await API.get('/player/klemb901/games?season=1905'),
    fixture('player_klemb901_games_season_1905'),
    ['total', ...rowPaths('umpired', 20, ['id', 'date', 'position', 'visName',
                                          'homeName', 'vis_score', 'home_score'])]);

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
