/* Baseball Games — client-side routing over app.py's JSON API.
   Kept deliberately plain: no build step, no framework, no dependencies. */
'use strict';

const app = document.getElementById('app');
let META = null;

// ------------------------------------------------------------------ helpers

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const n = v => (v === null || v === undefined || v === '') ? '' : v;

function avg(h, ab) {
  if (!ab) return '';
  return (h / ab).toFixed(3).replace(/^0/, '');
}

/* Blank, not 0.00, when the earned runs were never recorded: 1906 has them for
   17 of its 3,090 pitching lines and 1907 for 1,635 of 3,229, so a pitcher in
   those seasons summed to NULL and read as though he had allowed nothing. */
function era(er, outs) {
  if (!outs || er === null || er === undefined) return '';
  return (er * 27 / outs).toFixed(2);
}

function ip(outs) {
  if (outs === null || outs === undefined) return '';
  return Math.floor(outs / 3) + '.' + (outs % 3);
}

const rate3 = v => (v === null || !isFinite(v)) ? '' : v.toFixed(3).replace(/^0/, '');
const rate2 = v => (v === null || !isFinite(v)) ? '' : v.toFixed(2);

/* The rates the counting stats are actually read for. A season Retrosheet
   never recorded sacrifice flies in leaves them out of the denominator rather
   than counting them as none: that is what the NULL means, and adding a zero
   would quietly inflate the on-base percentage of everyone before 1954. */
const obpOf = r => {
  const d = (r.ab || 0) + (r.bb || 0) + (r.hbp || 0) + (r.sf || 0);
  return d ? ((r.h || 0) + (r.bb || 0) + (r.hbp || 0)) / d : null;
};
const slgOf = r => r.ab
  ? ((r.h || 0) + (r.d || 0) + 2 * (r.t || 0) + 3 * (r.hr || 0)) / r.ab : null;
const opsOf = r => {
  const a = obpOf(r), b = slgOf(r);
  return (a === null || b === null) ? null : a + b;
};
const whipOf = r => r.outs ? ((r.bb || 0) + (r.h || 0)) * 3 / r.outs : null;
const fpctOf = r => {
  const c = (r.po || 0) + (r.a || 0), t = c + (r.e || 0);
  return t ? c / t : null;
};

/* Sum a column across season rows, keeping "not recorded" distinct from zero:
   a career total of nothing but NULLs stays blank rather than becoming 0, so
   Ruth is not credited with 0 sacrifice flies in an era that never counted
   them. */
function colSum(rs, k) {
  let t = null;
  for (const r of rs) if (r[k] !== null && r[k] !== undefined) t = (t || 0) + r[k];
  return t;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function niceDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/* One frontend, two backings. The docs/ build loads api-local.js, which
   implements these same endpoints in the browser over the exported JSON;
   under app.py that file isn't there and this falls through to HTTP. Neither
   path gets its own copy of a view, so they cannot disagree about one. */
async function api(path) {
  if (window.LocalAPI) return window.LocalAPI.get(path);
  const r = await fetch('/api' + path);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}

function table(head, rows, opts = {}) {
  if (!rows.length) return `<p class="empty">${esc(opts.empty || 'Nothing here.')}</p>`;
  const th = head.map(h => `<th class="${h.l ? 'l' : ''}">${esc(h.t)}</th>`).join('');
  const tb = rows.map(r => '<tr' + (r._cls ? ` class="${r._cls}"` : '') + '>'
    + head.map((h, i) => `<td class="${h.l ? 'l' : 'num'}">${r.cells[i] ?? ''}</td>`).join('')
    + '</tr>').join('');
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`;
}

const link = (href, text) => `<a href="${href}">${esc(text)}</a>`;
const playerLink = (id, name) => id ? link('#/player/' + id, name || id) : esc(name || '');
const teamLink = (code, season, name) =>
  code ? link(`#/team/${code}?season=${season}`, name || code) : '';
const gameLink = (id, text) => link('#/game/' + id, text);

// ------------------------------------------------------------------- routing

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/games';
  const [path, qs] = raw.split('?');
  return { parts: path.split('/').filter(Boolean), q: new URLSearchParams(qs || '') };
}

const ROUTES = {
  games: viewGames,
  game: viewGame,
  player: viewPlayer,
  team: viewTeam,
  teams: viewTeams,
  notable: viewNotable,
  day: viewDay,
  park: viewPark,
  search: viewSearch,
  about: viewAbout,
};

/* Where the reader is, ignoring which day he has picked. Picking a day on the
   games calendar is a hash change like any other, and scrolling him back to
   the top would throw him off the control he just used -- the calendar is
   above the day's games, so the jump lands nowhere useful. Moving to another
   view, or changing a filter, still earns the scroll. */
function placeOf(parts, q) {
  return parts.join('/') + '|' + ['season', 'team', 'gametype', 'league', 'park',
    'q', 'kind'].map(k => q.get(k) || '').join('|');
}
let lastPlace = null;

async function route() {
  const { parts, q } = parseHash();
  const view = ROUTES[parts[0]] || viewGames;
  document.querySelectorAll('#tabs a').forEach(a =>
    a.classList.toggle('active', a.getAttribute('href') === '#/' + parts[0]));
  app.innerHTML = '<div class="empty">Loading…</div>';
  try {
    await view(parts.slice(1), q);
  } catch (e) {
    app.innerHTML = `<p class="empty">Couldn’t load that: ${esc(e.message)}</p>`;
  }
  const place = placeOf(parts, q);
  if (place !== lastPlace) window.scrollTo(0, 0);
  lastPlace = place;
}

// ------------------------------------------------------------- the calendar

/* Dates are strings throughout this app and stay strings, because
   new Date('2025-07-04') is UTC midnight and prints as the 3rd everywhere
   west of Greenwich. The calendar is the one place that needs real date
   arithmetic -- where a month's first day falls in the week, and how long
   the month is -- and it asks for that in UTC for the same reason.
   Retrosheet's own game.dow is what the tests check this against. */
const weekdayOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/* Every month from the first game to the last, inclusive, derived rather than
   assumed to be April to October: 1926 runs January to December, because the
   Negro League clubs played winter ball in Puerto Rico. */
function monthsBetween(first, last) {
  const out = [];
  let y = +first.slice(0, 4), m = +first.slice(5, 7);
  const ey = +last.slice(0, 4), em = +last.slice(5, 7);
  while (y < ey || (y === ey && m <= em)) {
    out.push([y, m]);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/* Fixed thresholds, not scaled to each season's own busiest day. A ramp that
   renormalised would paint 1871's lone Thursday game the same shade as a
   fifteen-game Sunday in 2025, and the difference between those is most of
   what a hundred and fifty years of calendars has to say. */
const dayBucket = n => (n >= 12 ? 5 : n >= 9 ? 4 : n >= 6 ? 3 : n >= 3 ? 2 : 1);

const DOW_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const RESULT_WORDS = { W: 'won', L: 'lost', T: 'tied' };

function calendarKeyHTML(byResult) {
  const item = (sw, label) => `<span class="key-item">${sw}${label}</span>`;
  const sw = (cls, text) => `<span class="key-sw ${cls}">${text || ''}</span>`;
  if (byResult) {
    return '<p class="cal-key">'
      + ['W', 'L', 'T'].map(r => item(sw('r-' + r, r), RESULT_WORDS[r])).join('')
      + item(sw('r-W', 'W') + sw('r-L', 'L'), 'doubleheader')
      + item(sw('off'), 'no game') + '</p>';
  }
  return '<p class="cal-key"><span class="key-item">Games</span>'
    + ['1–2', '3–5', '6–8', '9–11', '12+']
      .map((l, i) => item(sw('b' + (i + 1)), l)).join('')
    + item(sw('off'), 'none') + '</p>';
}

/* The whole season at once, a month to a grid. A month at a time would cost
   seven clicks to sweep a season and show nothing you did not already know;
   laid out together, the shape of the season is itself the answer -- the
   All-Star hole in July, October narrowing to a thread, 1994 stopping dead
   on the 11th of August. */
/* `byResult` is passed in rather than sniffed off the payload. Reading it back
   out of the rows -- days[0].length > 2 -- looked tidier and was one stray
   `undefined + ''` away from rendering a season of results that were never
   sent. The caller knows whether it asked for a club; it can say so. */
function calendarHTML(days, selected, byResult) {
  if (!days.length) return '<p class="empty">No games match those filters.</p>';
  const by = new Map(days.map(d => [d[0], d]));
  const months = monthsBetween(days[0][0], days[days.length - 1][0])
    .map(([y, m]) => {
      const lead = weekdayOf(y, m, 1);
      const cells = [];
      let played = 0;
      for (let i = 0; i < lead; i++) cells.push('<span class="cal-day pad"></span>');
      for (let d = 1; d <= daysInMonth(y, m); d++) {
        const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const e = by.get(iso);
        if (!e) {
          cells.push(`<span class="cal-day off"><span class="dnum">${d}</span></span>`);
          continue;
        }
        played += e[1];
        const results = byResult ? e[2].split('') : [];
        const label = `${niceDate(iso)} — ` + (byResult
          ? results.map(r => RESULT_WORDS[r] || 'played').join(', ')
          : `${e[1]} ${e[1] === 1 ? 'game' : 'games'}`);
        // The glyph, not the tint, is what carries the answer: a grid told
        // apart by colour alone is a grid of identical squares to about one
        // man in twelve.
        cells.push(`<button type="button" data-date="${iso}" title="${esc(label)}"`
          + ` aria-label="${esc(label)}"${iso === selected ? ' aria-current="date"' : ''}`
          + ` class="cal-day ${byResult ? 'r-' + results[0] : 'b' + dayBucket(e[1])}`
          // A doubleheader split won and lost is half green and half rust, so
          // the cell cannot read as a win at a glance the way a filled one does.
          + `${results.length > 1 ? ' dh dh2-' + results[1] : ''}`
          + `${iso === selected ? ' sel' : ''}">`
          + `<span class="dnum">${d}</span>`
          + `<span class="glyph">${byResult ? results.join(' ') : e[1]}</span></button>`);
      }
      return `<div class="cal-month"><h4>${MONTHS[m - 1]}<i>${played}</i></h4>`
        + `<div class="cal-dow" aria-hidden="true">${
          DOW_INITIALS.map(x => `<span>${x}</span>`).join('')}</div>`
        + `<div class="cal-grid">${cells.join('')}</div></div>`;
    }).join('');
  return `<div class="calendar" id="calendar">${months}</div>`
    + calendarKeyHTML(byResult);
}

/* The way into a game, and the one thing in these rows meant to be clicked to
   get there. A filled pill reads as a button, which is why the quiet ones
   beside it are not links.

   Muted where Retrosheet has no box score -- 19,664 games, all but a handful
   of them before 1900. Muted but still a link, because the page behind it is
   thin rather than empty: it has the result, the clubs and the park for all
   of them, an attendance for 7,198 and a line score for 2,578. Disabling the
   button would be the only way those 19,664 games could be opened at all.

   The word changes with the colour, so a reader who cannot tell the two pills
   apart still reads which is which. */
const boxLinkHTML = (g, suffix) => {
  const has = !!g.has_box;
  const title = has
    ? 'The box score, with the line score and the details'
    : 'Retrosheet has no box score for this game — the page has the result, '
      + 'the clubs and the park';
  return `<a class="pill${has ? '' : ' quiet'}" href="#/game/${g.id}" title="${
    esc(title)}">${has ? 'box' : 'game'}${esc(suffix || '')}</a>`;
};

// What else Retrosheet holds, not something to click in itself: the play-by-play
// is on file for 207,450 games, and the box link beside this one opens it.
const onFileHTML = g =>
  (g.has_pbp ? '<span class="pill quiet" title="Retrosheet has a'
    + ' pitch-by-pitch account of this game. Open the game to read it.">plays</span>' : '');

/* The games of the chosen day. No Date column: the heading above it is the
   date, and repeating it in every row says nothing. The link stays where the
   date used to be, and carries the doubleheader number, which is the one
   thing that does still tell the two rows apart. */
function dayGamesHTML(date, games) {
  const rows = games.map(g => ({
    cells: [
      // The doubleheader number rides on the button here, because there is no
      // Date column to carry it and two rows of the same two clubs need
      // telling apart. "box 2" is the box score of the second game.
      boxLinkHTML(g, g.number !== '0' ? ' ' + g.number : ''),
      teamLink(g.vis, g.season, g.visName),
      n(g.vis_score),
      teamLink(g.home, g.season, g.homeName),
      n(g.home_score),
      g.parkName ? link('#/park/' + g.park, g.parkName) : '',
      g.attendance ? g.attendance.toLocaleString() : '',
      onFileHTML(g),
    ],
  }));
  return `<div class="gamelist"><h3>${niceDate(date)}</h3>
    <p class="note">${games.length} ${games.length === 1 ? 'game' : 'games'}</p>
    ${table([{ t: 'Box', l: 1 }, { t: 'Visitor', l: 1 }, { t: 'R' },
             { t: 'Home', l: 1 }, { t: 'R' }, { t: 'Park', l: 1 },
             { t: 'Attendance' }, { t: 'On file', l: 1 }], rows,
            { empty: 'No games that day.' })}</div>`;
}

/* The games a narrow filter came back with, listed under the calendar for the
   whole season rather than one day of it. The Date column returns here because
   these rows run from April to October; on a single day it would only repeat
   the heading in every row, which is why dayGamesHTML has none. */
function seasonGamesHTML(games, total, ctx) {
  const rows = games.map(g => ({
    cells: [
      boxLinkHTML(g),
      /* The date picks the day, the way a date does everywhere else in this
         tab -- it selects that cell on the calendar above and lists what was
         played, rather than jumping to one game's box score. Getting to the
         box score is what the button is for. The filters ride along, so this
         and a click on the calendar cell land in the same place. */
      link(gamesHash(Object.assign({}, ctx, { date: g.date })),
           niceDate(g.date) + (g.number !== '0' ? ` (${g.number})` : '')),
      teamLink(g.vis, g.season, g.visName),
      n(g.vis_score),
      teamLink(g.home, g.season, g.homeName),
      n(g.home_score),
      g.parkName ? link('#/park/' + g.park, g.parkName) : '',
      g.attendance ? g.attendance.toLocaleString() : '',
      onFileHTML(g),
    ],
  }));
  return `<div class="gamelist">
    ${games.length < total ? `<p class="note">Showing the first ${
      games.length.toLocaleString()} of ${total.toLocaleString()}.</p>` : ''}
    ${table([{ t: 'Box', l: 1 }, { t: 'Date', l: 1 }, { t: 'Visitor', l: 1 },
             { t: 'R' }, { t: 'Home', l: 1 }, { t: 'R' }, { t: 'Park', l: 1 },
             { t: 'Attendance' }, { t: 'On file', l: 1 }], rows,
            { empty: 'No games match those filters.' })}</div>`;
}

/* The one place a games URL is built, so the three ways of changing this view
   -- a select, a calendar cell, dropping the park -- cannot drift apart.

   The day and the park are season-scoped and pass `was` to say so. Both were
   chosen inside a single year: the day from a cell on that season's calendar,
   the park from a row on a park page reading "1923 — 79 games". Reinterpreted
   against another season they answer a question nobody asked, and where the
   park stood idle that year they answer with an empty calendar and no
   control to explain it. So a change of season drops them. */
function gamesHash({ season, team, gametype, league, park, date, was }) {
  const p = new URLSearchParams({ season });
  if (team) p.set('team', team);
  if (gametype) p.set('gametype', gametype);
  /* The league is season-scoped like the day and the park: the Negro National
     League is not a thing 1962 has, and carrying it across would leave the
     reader on an empty calendar with a control reading a league that never
     played that year. viewGames drops any league the season did not have, so
     this only has to stop it being written. */
  const sameSeason = was === undefined || String(season) === String(was);
  if (league && sameSeason) p.set('league', league);
  if (park && sameSeason) p.set('park', park);
  if (date && sameSeason) p.set('date', date);
  return '#/games?' + p;
}

// --------------------------------------------------------------- game finder

async function viewGames(_, q) {
  const season = q.get('season') || META.lastSeason;
  const team = q.get('team') || '';
  let gametype = q.get('gametype') || '';
  const date = q.get('date') || '';
  const park = q.get('park') || '';

  /* Only the kinds of game this season actually had. 1968 has no division
     series and no wild card because neither existed; 2020 has no All-Star
     game and 1994 no World Series because neither was played. Offering them
     is offering an empty result. Where a season has one kind only -- 32 of
     them do -- "Any" and that kind mean the same thing, so the control goes
     away rather than sit there doing nothing.

     Settled before the query, not after: a type carried over from another
     season in the URL would otherwise be sent, come back with nothing, and
     leave the reader looking at an empty table and a filter reading "Any". */
  const seasonTypes = (META.seasonTypes || {})[season] || Object.keys(META.gametypes);
  if (!seasonTypes.includes(gametype)) gametype = '';

  /* And only the leagues it actually had. 113 of the 155 seasons had one, so
     the control is absent almost everywhere and appears for the 42 that need
     it: 1882-91 when the American Association ran beside the National League,
     1914-15 for the Federal League, and 1920-49 for the Negro Leagues. A
     league is not a kind of game, which is why this is its own filter rather
     than another entry in Type -- 1933 used to offer "Negro Leagues" beside
     "World Series" as though those were alternatives, and put two
     competitions in one calendar. */
  const seasonLeagues = (META.seasonLeagues || {})[season] || [];
  let league = q.get('league') || '';
  if (!seasonLeagues.includes(league)) league = '';

  /* The club list follows the league, so choosing one narrows the next control
     rather than leaving 1933 offering every Negro League club to a reader
     looking at the Major Leagues. */
  const teams = (await api('/teams?season=' + season
    + (league ? '&league=' + encodeURIComponent(league) : ''))).teams;

  /* Whether a list of games belongs under the calendar at all.

     A club, or a round other than the regular season, is a filter narrow
     enough to read: the largest club-season on record is 180 games (the 2003
     Yankees among others) and the largest round is 289 (the 1926 Negro
     Leagues); every other round is twenty or fewer. Left at Every club and
     Any, a season is 2,478 games in 2025, which is the list this tab was
     built to stop showing. There the calendar is the whole answer, and a day
     has to be picked before there is anything to tabulate.

     A park is the same kind of filter as a club -- the busiest a park has
     ever been in one season is 173 games, Shibe Park in 1946 with two clubs
     sharing it -- and listing its games is also what puts its name on screen,
     which is how the reader can see the filter is on at all.

     Regular season counts as no filter at all: in 123 of the 155 seasons it
     is all but a handful of the games, so choosing it narrows nothing. */
  /* A league is a narrowing like a club: the largest of the 42 seasons' minor
     entries is a few hundred games, and picking the Negro National League in
     1933 should give the 170 games it played rather than a calendar. The
     Major Leagues are not -- they are the season, so that stays a calendar. */
  const narrowLeague = !!league && league !== 'MLB'
    && !(seasonLeagues.length && league === seasonLeagues[0] && season < 1901);
  const narrow = !!team || !!park || narrowLeague
    || (gametype !== '' && gametype !== 'regular');
  const wantList = !!date || narrow;
  /* 400 covers the widest of those with room to spare, and asking for none is
     what keeps the calendar-only view from putting rows on the wire that
     nothing is going to render. */
  const params = new URLSearchParams({ season, limit: wantList ? 400 : 0 });
  if (team) params.set('team', team);
  if (league) params.set('league', league);
  if (gametype) params.set('gametype', gametype);
  if (date) params.set('date', date);
  if (park) params.set('park', park);
  const data = await api('/games?' + params);

  /* A day carried in on the URL may have no games under the filters now in
     force -- pick a club that was idle that afternoon and the cell is not
     there to select. Drop the selection rather than show an empty table
     beneath a calendar with nothing highlighted in it. */
  const selected = data.days.some(d => d[0] === date) ? date : '';

  const typeOpts = ['<option value="">Any</option>'].concat(
    seasonTypes.map(k =>
      `<option value="${k}"${k === gametype ? ' selected' : ''}>${
        esc(META.gametypes[k] || k)}</option>`)).join('');
  const leagueOpts = ['<option value="">Every league</option>'].concat(
    seasonLeagues.map(k =>
      `<option value="${k}"${k === league ? ' selected' : ''}>${
        esc((META.leagues || {})[k] || k)}</option>`)).join('');
  const teamOpts = ['<option value="">Every club</option>'].concat(
    teams.map(t => `<option value="${t.id}"${t.id === team ? ' selected' : ''}>${
      esc((t.city || '') + ' ' + (t.nickname || ''))}</option>`)).join('');
  const years = [];
  for (let y = META.lastSeason; y >= META.firstSeason; y--) years.push(y);

  // The season's own total, summed off the calendar rather than read from
  // `total` -- once a day is picked, `total` counts that day.
  const games = data.days.reduce((a, d) => a + d[1], 0);

  /* The park has no select of its own, because it arrives from a link on a
     park page rather than being chosen here. Without something on screen the
     reader cannot see that it is filtering at all, let alone turn it off --
     and a park that stood idle in the season he has since moved to leaves
     him staring at "0 games" with all three controls reading wide open.

     The name comes off the games it matched, free. Where it matched none --
     which is precisely the state most in need of explaining, a season of "0
     games" under three controls reading wide open -- there is no name among
     them to read, so the park page is asked for it. One request, only in the
     case that would otherwise put a bare code on screen. */
  let parkName = park ? ((data.games.find(g => g.parkName) || {}).parkName || '') : '';
  if (park && !parkName) {
    try { parkName = (await api('/park/' + park)).park.name; }
    catch (e) { parkName = park; }
  }

  app.innerHTML = `
    <div class="controls">
      <label>Season<select id="f-season">${years.map(y =>
        `<option${y == season ? ' selected' : ''}>${y}</option>`).join('')}</select></label>
      ${seasonLeagues.length > 1
        ? `<label>League<select id="f-league">${leagueOpts}</select></label>` : ''}
      <label>Club<select id="f-team">${teamOpts}</select></label>
      ${seasonTypes.length > 1
        ? `<label>Type<select id="f-type">${typeOpts}</select></label>` : ''}
      ${park ? `<label>Park<span class="parkfilter">${esc(parkName)}<a
        href="${gamesHash({ season, team, gametype, league, date: selected })}"
        title="Show every park" aria-label="Remove the park filter">×</a></span></label>` : ''}
    </div>
    <h2>${games.toLocaleString()} games in ${season}</h2>
    <p class="note">${data.days.length
      ? `${data.days.length} ${data.days.length === 1 ? 'day' : 'days'}, ${
        niceDate(data.days[0][0])} to ${niceDate(data.days[data.days.length - 1][0])}.`
      : ''}</p>
    ${calendarHTML(data.days, selected, !!team)}
    ${selected ? dayGamesHTML(selected, data.games)
      : (narrow && data.days.length)
        ? seasonGamesHTML(data.games, data.total, { season, team, gametype, league, park })
        : ''}`;

  const go = () => {
    const t = document.getElementById('f-type');
    const l = document.getElementById('f-league');
    location.hash = gamesHash({
      season: val('f-season'), team: val('f-team'), gametype: t ? t.value : '',
      league: l ? l.value : '', park, date: selected, was: season,
    });
  };
  ['f-season', 'f-league', 'f-team', 'f-type'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', go);
  });

  const cal = document.getElementById('calendar');
  if (cal) {
    cal.addEventListener('click', ev => {
      const cell = ev.target.closest('button[data-date]');
      if (!cell) return;
      // Clicking the day already open puts it away again. The calendar is its
      // own deselect, so there is no third control to explain.
      location.hash = gamesHash({
        season, team, gametype, league, park,
        date: cell.dataset.date === selected ? '' : cell.dataset.date,
      });
    });
  }
}

const val = id => document.getElementById(id).value;

// ---------------------------------------------------------------- one game

function lineScoreHTML(g) {
  const v = g.visLine, h = g.homeLine;
  const innings = Math.max(v.length, h.length);
  if (!innings) return '';
  const head = ['<th class="l"></th>'];
  for (let i = 1; i <= innings; i++) head.push(`<th>${i}</th>`);
  head.push('<th class="rhe">R</th><th class="rhe">H</th><th class="rhe">E</th>');
  const row = (name, code, line, r, hits, errs) =>
    `<tr><td class="team">${esc(name)}</td>`
    + Array.from({ length: innings }, (_, i) => `<td>${esc(line[i] ?? '')}</td>`).join('')
    + `<td class="rhe">${n(r)}</td><td class="rhe">${n(hits)}</td><td class="rhe">${n(errs)}</td></tr>`;
  return `<div class="linescore-wrap"><div class="linescore"><table>
    <thead><tr>${head.join('')}</tr></thead><tbody>
    ${row(g.visName, g.vis, v, g.vis_score, g.v_h, g.v_e)}
    ${row(g.homeName, g.home, h, g.home_score, g.h_h, g.h_e)}
  </tbody></table></div></div>`;
}

/* AB R H RBI BB SO and nothing else, the way a printed box score reads. The
   extra-base hits and the running are itemised underneath in boxSummaryHTML
   rather than given a column each, most of which would be zeroes. */
function battingTable(all) {
  // Slot 0 is a man who never entered the batting order -- since the DH, the
  // pitchers. A box score lists them under Pitching, not among the batters.
  const rows = all.filter(b => b.slot == null || b.slot > 0);
  // A box score indents anyone who came into a lineup place someone else
  // started in. The rows arrive in slot-then-sequence order, so the first
  // appearance of a slot is the starter and everything after it is a
  // replacement -- no need to carry the sequence number to know that.
  const started = new Set();
  const body = rows.map(b => {
    const replacement = b.slot != null && started.has(b.slot);
    if (b.slot != null) started.add(b.slot);
    const label = playerLink(b.person, b.name)
      + (b.positions.length ? ` <span class="note">${esc(b.positions.join('-').toLowerCase())}</span>` : '')
      + (b.pinchHitInning ? ` <span class="pill quiet" title="Pinch-hit in the ${
           b.pinchHitInning} inning">PH ${b.pinchHitInning}</span>` : '')
      + (b.pinchRunInning ? ` <span class="pill quiet" title="Pinch-ran in the ${
           b.pinchRunInning} inning">PR ${b.pinchRunInning}</span>` : '');
    return { cells: [
      replacement ? `<span class="sub">${label}</span>` : label,
      n(b.ab), n(b.r), n(b.h), n(b.rbi), n(b.bb), n(b.so),
    ] };
  });
  const sum = k => rows.reduce((a, b) => a + (b[k] || 0), 0);
  if (rows.length) {
    body.push({
      _cls: 'totals',
      cells: ['Totals', sum('ab'), sum('r'), sum('h'), sum('rbi'), sum('bb'), sum('so')],
    });
  }
  return table([{ t: 'Batting', l: 1 }, { t: 'AB' }, { t: 'R' }, { t: 'H' },
                { t: 'RBI' }, { t: 'BB' }, { t: 'SO' }],
               body, { empty: 'No batting lines recorded.' });
}

const DECISION = { W: ['win', 'Winning pitcher'], L: ['loss', 'Losing pitcher'],
                   SV: ['save', 'Save'] };

/* The decision belongs against the man who earned it, not in a separate list
   at the top of the page that makes you match names up by eye. */
function pitchingTable(rows, decisions = {}) {
  const body = rows.map(p => {
    const d = decisions[p.person];
    const [cls, title] = d ? DECISION[d] : [];
    return {
      cells: [playerLink(p.person, p.name)
        + (d ? ` <span class="pill ${cls}" title="${title}">${d}</span>` : ''),
        ip(p.outs), n(p.h), n(p.r), n(p.er), n(p.bb), n(p.so), n(p.hr)],
    };
  });
  return table([{ t: 'Pitching', l: 1 }, { t: 'IP' }, { t: 'H' }, { t: 'R' }, { t: 'ER' },
                { t: 'BB' }, { t: 'SO' }, { t: 'HR' }], body,
               { empty: 'No pitching lines recorded.' });
}

function ordinal(n_) {
  if (n_ == null) return '';
  const s = ['th', 'st', 'nd', 'rd'], v = n_ % 100;
  return n_ + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* "Wallner, Sosa 2" — a name, and a count only when it isn't one. */
function tally(entries) {
  const seen = new Map();
  for (const { name, count } of entries) {
    seen.set(name, (seen.get(name) || 0) + (count || 1));
  }
  return [...seen].map(([name, c]) => name + (c > 1 ? ' ' + c : ''));
}

const tb = b => (b.h || 0) + (b.d || 0) + 2 * (b.t || 0) + 3 * (b.hr || 0);

/* The notes a modern box score carries under the line-ups, grouped the way
   MLB's Gameday groups them: Batting, Baserunning, Fielding, then the
   pitching notes.

   Doubles, triples and total bases come from the batting lines — Retrosheet
   itemises home runs, steals and double plays as events, but not those.
   Anything needing to know the base-out state when a ball was hit (two-out
   RBI, runners left in scoring position, RISP) is absent on purpose: those
   would mean replaying the innings, and this summary is built from the
   box-score tables, which carry the totals and not the state. */
function boxSummaryHTML(batting, pitching, events, teamBox, sides) {
  const byKind = {};
  events.forEach(e => (byKind[e.kind] = byKind[e.kind] || []).push(e));
  const nm = b => b.lastName || b.name;
  const groups = [];

  function section(title, build) {
    const items = [];
    build((label, list) => { if (list && list.length) items.push([label, list.join('; ')]); });
    if (items.length) groups.push([title, items]);
  }

  section('Batting', add => {
    add('2B', tally(batting.filter(b => b.d > 0).map(b => ({ name: nm(b), count: b.d }))));
    add('3B', tally(batting.filter(b => b.t > 0).map(b => ({ name: nm(b), count: b.t }))));
    /* Home runs carry the inning, the pitcher and how many were aboard, and
       they group by batter the way a box score prints them: a man who hit two
       is named once, with his count and both accounts of them, rather than
       appearing twice in a list that never says he did it twice.

       The runners aboard are on the event as runners_on. This read e.on, which
       is on nothing, so the count had never once appeared -- 335,983 of the
       335,984 home runs in the database carry it. */
    const hrs = byKind.hr || [];
    const byBatter = new Map();
    for (const e of hrs) {
      const who = e.playerLast?.[0] || e.playerNames[0];
      const off = e.playerLast?.[1] ? ` off ${e.playerLast[1]}` : '';
      // A solo home run says nothing, the way it is written on paper.
      const on = e.runners_on ? `, ${e.runners_on} on` : '';
      if (!byBatter.has(who)) byBatter.set(who, []);
      byBatter.get(who).push(`${ordinal(e.inning)}${off}${on}`);
    }
    add('HR', hrs.length
      ? [...byBatter].map(([who, list]) =>
        `${who}${list.length > 1 ? ' ' + list.length : ''} (${list.join(', ')})`)
      : tally(batting.filter(b => b.hr > 0).map(b => ({ name: nm(b), count: b.hr }))));
    add('TB', tally(batting.filter(b => tb(b) > 0).map(b => ({ name: nm(b), count: tb(b) }))));
    add('RBI', tally(batting.filter(b => b.rbi > 0).map(b => ({ name: nm(b), count: b.rbi }))));
    add('SH', tally(batting.filter(b => b.sh > 0).map(b => ({ name: nm(b), count: b.sh }))));
    add('SF', tally(batting.filter(b => b.sf > 0).map(b => ({ name: nm(b), count: b.sf }))));
    add('GIDP', tally(batting.filter(b => b.gidp > 0).map(b => ({ name: nm(b), count: b.gidp }))));
    add('Team LOB', [0, 1].map(s => teamBox?.[s]?.lob)
      .map((v, i) => (v == null ? null : `${sides[i]} ${v}`)).filter(Boolean));
  });

  section('Baserunning', add => {
    const sb = byKind.sb || [], cs = byKind.cs || [];
    add('SB', sb.length
      ? tally(sb.map(e => ({ name: e.playerLast?.[0] || e.playerNames[0] })))
      : tally(batting.filter(b => b.sb > 0).map(b => ({ name: nm(b), count: b.sb }))));
    add('CS', cs.length
      ? tally(cs.map(e => ({ name: e.playerLast?.[0] || e.playerNames[0] })))
      : tally(batting.filter(b => b.cs > 0).map(b => ({ name: nm(b), count: b.cs }))));
  });

  section('Fielding', add => {
    // Written as the sequence of fielders who turned it, the way a box score does
    add('DP', (byKind.dp || []).map(e => (e.playerLast || e.playerNames).join('-')));
    add('TP', (byKind.tp || []).map(e => (e.playerLast || e.playerNames).join('-')));
  });

  section('Pitching', add => {
    add('WP', tally(pitching.filter(p => p.wp > 0).map(p => ({ name: nm(p), count: p.wp }))));
    add('Balk', tally(pitching.filter(p => p.bk > 0).map(p => ({ name: nm(p), count: p.bk }))));
    add('HBP', (byKind.hp || []).map(e => {
      const [pitcher, batter] = e.playerLast || e.playerNames;
      return batter ? `${batter} (by ${pitcher})` : pitcher;
    }));
    add('Batters faced', pitching.filter(p => p.bfp != null)
      .map(p => `${nm(p)} ${p.bfp}`));
  });

  if (!groups.length) return '';
  return groups.map(([title, items]) =>
    `<h3>${esc(title)}</h3><ul class="events">${items.map(([k, v]) =>
      `<li><span class="k">${esc(k)}</span> ${esc(v)}</li>`).join('')}</ul>`).join('');
}

const UMP_SPOTS = [['ump_hp', 'HP'], ['ump_1b', '1B'], ['ump_2b', '2B'],
                   ['ump_3b', '3B'], ['ump_lf', 'LF'], ['ump_rf', 'RF']];

/* Everything about the occasion rather than the play: where, who officiated,
   how long it took, what the weather was doing. It sits under the box score
   because that is where a box score puts it. */
function gameInfoHTML(g, park, p, pitching) {
  const items = [];
  const add = (k, v) => { if (v) items.push([k, v]); };
  add('Venue', park ? link('#/park/' + park.id, park.name) : esc(g.park || ''));
  add('Attendance', g.attendance ? g.attendance.toLocaleString() : '');
  add('First pitch', esc(g.start_time || ''));
  add('T', g.duration
    ? `${Math.floor(g.duration / 60)}:${String(g.duration % 60).padStart(2, '0')}` : '');
  add('Weather', esc([g.temp ? g.temp + '°F' : '',
    g.sky && g.sky !== 'unknown' ? g.sky : ''].filter(Boolean).join(', ')));
  add('Wind', esc(g.wind_speed
    ? `${g.wind_speed} mph${g.wind_dir && g.wind_dir !== 'unknown' ? ', ' + g.wind_dir : ''}` : ''));
  add('Umpires', UMP_SPOTS.map(([k, spot]) => (p[k] ? `${spot}: ${p[k]}` : null))
    .filter(Boolean).map(esc).join('. '));
  add('Managers', esc([p.mgr_vis, p.mgr_home].filter(Boolean).join(' / ')));

  // The decisions are pills beside their pitchers. They are named here only
  // when the man has no line to carry one -- 1,744 games where the log records
  // who won and lost and there is no box score to put him in.
  const pitched = new Set(pitching.map(x => x.person));
  for (const [key, label] of [['wp', 'Winning pitcher'], ['lp', 'Losing pitcher'],
                              ['sv', 'Save']]) {
    if (g[key] && !pitched.has(g[key])) add(label, playerLink(g[key], p[key]));
  }

  if (!items.length) return '';
  return `<h3>Game info</h3><ul class="events">${items.map(([k, v]) =>
    `<li><span class="k">${k}</span> ${v}</li>`).join('')}</ul>`;
}

async function viewGame(parts) {
  const d = await api('/game/' + parts[0]);
  const g = d.game, p = d.people;

  const decisions = {};
  if (g.wp) decisions[g.wp] = 'W';
  if (g.lp) decisions[g.lp] = 'L';
  if (g.sv) decisions[g.sv] = 'SV';

  const sides = [0, 1].map(side => ({
    side,
    name: side === 0 ? g.visName : g.homeName,
    bat: d.batting.filter(b => b.side === side),
    pit: d.pitching.filter(x => x.side === side),
  }));

  app.innerHTML = `
    <div class="crumb">${link('#/games?season=' + g.season, g.season + ' games')}
      · ${link(`#/games?season=${g.season}&date=${g.date}`, 'every game that day')}</div>
    <div class="gamehead">
      <div class="score">
        <span class="${g.vis_score > g.home_score ? 'win' : ''}">${esc(g.visName)} ${n(g.vis_score)}</span>
        &nbsp;at&nbsp;
        <span class="${g.home_score > g.vis_score ? 'win' : ''}">${esc(g.homeName)} ${n(g.home_score)}</span>
      </div>
      <div>${esc(g.gametypeLabel)}${g.has_pbp
        ? '<span class="pill quiet" title="Retrosheet has a pitch-by-pitch'
          + ' account of this game, below the box score.">'
          + 'play-by-play on file</span>'
        : ''}</div>
    </div>
    <p class="note">${niceDate(g.date)}${g.number !== '0' ? ` — game ${g.number} of a doubleheader` : ''}</p>
    ${lineScoreHTML(g)}
    ${sides.map(s => `<h3>${esc(s.name)}</h3>${battingTable(s.bat)}${
      pitchingTable(s.pit, decisions)}`).join('')}
    ${boxSummaryHTML(d.batting, d.pitching, d.events, d.teamBox,
                     [g.visName, g.homeName])}
    ${g.has_pbp ? `<h3>Play by play</h3>${playsCanBeRead()
      ? `<p class="note"><button id="pbp-open" class="pill">Show every play</button></p>
         <div id="pbp"></div>`
      /* The shards are gzipped to fit inside the 1 GB a GitHub Pages site is
         allowed, so reading them needs DecompressionStream. Saying so beats a
         button that fails, and the rest of the page is unaffected. */
      : `<p class="empty">Your browser can't read the play-by-play files —
         they are compressed, and this needs DecompressionStream (Safari 16.4,
         Firefox 113 or Chrome 80 and later). Everything else on this page
         works.</p>`}` : ''}
    ${gameInfoHTML(g, d.park, p, d.pitching)}`;

  /* Built when asked for, not before. The plays are Retrosheet's shorthand
     and expanding them is a pure function of the string, so there is nothing
     to precompute and nothing to store -- the page fetches the game's own
     plays and turns them into English at the moment of reading. */
  const open = document.getElementById('pbp-open');
  if (open) open.addEventListener('click', async () => {
    const box = document.getElementById('pbp');
    open.disabled = true;
    box.innerHTML = '<p class="note">Reading the play-by-play…</p>';
    try {
      const pbp = await api(`/game/${g.id}/plays`);
      box.innerHTML = playsHTML(pbp.plays, [g.visName, g.homeName]);
      open.closest('p').remove();
    } catch (e) {
      box.innerHTML = '<p class="empty">Could not read the play-by-play.</p>';
      open.disabled = false;
    }
  });
}

// ------------------------------------------------------------- play-by-play

/* Retrosheet's event notation, expanded where it is read rather than stored
   expanded. "S8/L.2-H" is eight bytes; its English is ninety, and there are
   18,263,689 of them. The grammar has three parts -- the basic play, then any
   number of "/" modifiers, then the runners' advances after a full stop --
   and is specified at https://www.retrosheet.org/eventfile.htm.

   This covers the concentrated head of it. 2019's 222,047 plays use 11,914
   distinct event strings but only 255 distinct shapes, and K, NP, W, HR and
   the plain fielder outs are most of them. Anything unrecognised is shown
   verbatim, so a gap reads as shorthand on the page rather than as a
   confidently wrong sentence. */

const FIELDER = { 1: 'pitcher', 2: 'catcher', 3: 'first baseman',
  4: 'second baseman', 5: 'third baseman', 6: 'shortstop', 7: 'left fielder',
  8: 'center fielder', 9: 'right fielder' };

const HIT_TO = { 1: 'the pitcher', 2: 'the catcher', 3: 'first base',
  4: 'second base', 5: 'third base', 6: 'shortstop', 7: 'left field',
  8: 'center field', 9: 'right field' };

const TRAJECTORY = { G: 'ground ball', L: 'line drive', F: 'fly ball',
  P: 'pop up', BG: 'bunt', BP: 'bunt pop up', BL: 'bunt line drive' };

const BASE_NAME = { 1: 'first', 2: 'second', 3: 'third', H: 'home', B: 'the batter' };

/* Where the ball went. The location rides inside the trajectory modifier --
   "F9LD" is a fly ball to 9LD -- and Retrosheet documents the zones only in a
   diagram, hitloc.jpg, so this grammar is read off our own data: a zone of one
   or two fielder positions, then a side (L, R, M), a depth (S, D, XD) and F for
   foul. 95 distinct codes cover 867,364 located balls since 2015.

   Coverage is a property of the era, not of the play. From 1989 about 97% of
   trajectories carry a location; before 1988 it is under 27% and erratic --
   24% in 1925, 2.4% in 1950, 26% in 1985 -- so an old game reading bare is the
   source being silent, and the About page says so.

   Depth is dropped on the bare infield positions: "deep shortstop" is not a
   place, and the fielder is already the location there. It stays on the
   outfield and on the zones between two men, where it is most of the news. */
const LOC_ZONE = {
  1: 'the pitcher', 2: 'the plate', 3: 'first base', 4: 'second base',
  5: 'third base', 6: 'shortstop', 7: 'left field', 8: 'center field',
  9: 'right field', 13: 'between the mound and first',
  15: 'between the mound and third', 23: 'between the plate and first',
  25: 'between the plate and third', 34: 'between first and second',
  56: 'between third and short', 78: 'left-center', 89: 'right-center',
};
const LOC_DEPTH = { S: 'shallow', D: 'deep', XD: 'extra deep' };
const OUTFIELD = new Set(['7', '8', '9', '78', '89']);

function locationPhrase(code) {
  const m = /^(\d{1,2})([LRM]*)(XD|S|D)?(F?)W?$/.exec(code || '');
  if (!m || !LOC_ZONE[+m[1]]) return '';
  const [, zone, side, depth, foul] = m;
  const place = LOC_ZONE[+zone];
  // "6M" and "4M" are the one ball everybody has a name for already.
  if (side.includes('M') && (zone === '4' || zone === '6')) return 'up the middle';
  // Down the line, which the side letter means only in the corner outfields.
  if (side.includes('L') && (zone === '7' || zone === '9')) {
    const line = zone === '7' ? 'down the left-field line' : 'down the right-field line';
    return foul ? line + ' in foul ground' : line;
  }
  // In centre, the side letter is the half of the field, which is the gap.
  const named = (side.includes('L') && zone === '8') ? 'left-center'
    : (side.includes('R') && zone === '8') ? 'right-center' : place;
  const deep = depth && (OUTFIELD.has(zone) || zone.length === 2) ? LOC_DEPTH[depth] : '';
  const where = (deep ? deep + ' ' : '') + named;
  if (foul) return 'into foul ground by ' + place;
  return where.startsWith('between') || where.startsWith('up ') ? where : 'to ' + where;
}

const fielders = s => [...String(s)].map(d => FIELDER[+d]).filter(Boolean);

/* The basic play. Order matters: POCS before PO, HP before H, IW before W,
   DGR before D -- each longer code would otherwise be eaten by its prefix. */
function describeBasic(play, mods) {
  // The trajectory and the location are one modifier: "F9LD" is both.
  const hit = mods.map(m => m.match(/^(BG|BP|BL|G|L|F|P)(\d[A-Z0-9]*)?$/)).find(Boolean);
  const traj = hit && hit[1];
  const where = hit && hit[2] ? locationPhrase(hit[2]) : '';
  const shape = TRAJECTORY[traj];
  const dp = mods.some(m => /^(GDP|LDP|FDP|BGDP|BPDP|DP)$/.test(m));
  const tp = mods.some(m => /^(GTP|LTP|TP)$/.test(m));
  const sf = mods.includes('SF'), sh = mods.includes('SH');
  let m;

  /* The running plays and the battery's mistakes come first. They begin with
     letters the hits also begin with -- SB2 would otherwise read as a single,
     WP as a walk -- so precedence is doing real work here, not tidiness. */
  if (/^(SB|CS|POCS|PO)[123H]/.test(play)) {
    return play.split(';').map(one => {
      const q = one.match(/^(POCS|CS|SB|PO)([123H])/);
      if (!q) return one;
      const base = BASE_NAME[q[2] === 'H' ? 'H' : +q[2]];
      return { SB: 'Stole ', CS: 'Caught stealing ', PO: 'Picked off ',
               POCS: 'Picked off and caught stealing ' }[q[1]] + base;
    }).join(', ');
  }
  if (play.startsWith('WP')) return 'Wild pitch';
  if (play.startsWith('PB')) return 'Passed ball';
  if (play.startsWith('BK')) return 'Balk';
  if (play.startsWith('DI')) return 'Defensive indifference';
  if (play.startsWith('NP')) return 'No play';
  if (play.startsWith('OA')) return 'Runner advanced';
  if (play.startsWith('HP')) return 'Hit by pitch';

  // A ball two men handled is written with both -- S67, S49 -- and the first
  // is the one who fielded it.
  if ((m = play.match(/^([SDT])(\d*)(?![A-Z])/)) && !play.startsWith('DGR')) {
    const kind = { S: 'Single', D: 'Double', T: 'Triple' }[m[1]];
    // The location when it was recorded, the fielder who took it when it
    // wasn't: "S8" says only that centre field handled the ball.
    return kind + (where ? ' ' + where : m[2] ? ' to ' + HIT_TO[+m[2][0]] : '');
  }
  if (play.startsWith('DGR')) return 'Ground-rule double';
  if ((m = play.match(/^HR?(\d*)/)) && !play.startsWith('HP')) {
    return 'Home run' + (where ? ' ' + where : m[1] ? ' to ' + HIT_TO[+m[1][0]] : '');
  }
  if (play.startsWith('HP')) return 'Hit by pitch';
  if (play.startsWith('K')) {
    return 'Strikeout' + (mods.includes('C') ? ' looking' : '');
  }
  if (/^IW?$/.test(play) || play.startsWith('IW')) return 'Intentional walk';
  if (play.startsWith('W')) return 'Walk';
  if ((m = play.match(/^FLE(\d)/))) return 'Error on a foul fly by the ' + FIELDER[+m[1]];
  if ((m = play.match(/^E(\d)/))) return 'Reached on an error by the ' + FIELDER[+m[1]];
  if ((m = play.match(/^FC(\d)?/))) {
    return "Fielder's choice" + (m[1] ? ', ' + FIELDER[+m[1]] : '');
  }
  if (/^C$/.test(play)) return "Catcher's interference";
  // "64(1)3" is 6 to 4 to 3; the (1) says which runner was put out, and
  // stripping it is what keeps the third fielder in the sequence.
  if ((m = play.replace(/\([^)]*\)/g, '').match(/^(\d+)/))) {
    const who = fielders(m[1]);
    const out = tp ? 'Triple play' : dp ? 'Double play'
      : sf ? 'Sacrifice fly' : sh ? 'Sacrifice bunt'
      : shape ? shape.charAt(0).toUpperCase() + shape.slice(1) + ' out' : 'Out';
    /* A ball caught in the air is better placed than named: the man who
       settled under it is not always where it was hit, and "F78XD" is an
       extra-deep drive to the gap that the centre fielder ran down. On the
       ground the chain of fielders already says where it went. */
    const air = ['F', 'P', 'L', 'BP', 'BL'].includes(traj);
    return who.length > 1 ? `${out}, ${who.join(' to ')}`
      : `${out}${air && where ? ' ' + where
                 : who.length ? ' to the ' + who[0] : ''}`;
  }
  return null;   // unrecognised: the caller shows the shorthand instead
}

/* "2-H;1-3" -- the runner on second scored, the runner on first reached
   third. An X in place of the dash is an out. The parenthesised fielders are
   dropped: they are the put-out credit, which the box score already carries. */
function describeAdvances(adv) {
  if (!adv) return [];
  return adv.split(';').map(a => {
    const m = a.replace(/\([^)]*\)/g, '').match(/^([123BH])([-X])([123BH])$/);
    if (!m) return null;
    const from = BASE_NAME[m[1] === 'H' || m[1] === 'B' ? m[1] : +m[1]];
    const to = BASE_NAME[m[3] === 'H' || m[3] === 'B' ? m[3] : +m[3]];
    const who = m[1] === 'B' ? 'Batter' : 'Runner on ' + from;
    if (m[2] === 'X') return `${who} out at ${to}`;
    if (m[3] === 'H') return `${who} scored`;
    if (m[1] === m[3]) return null;   // "3-3" is an explicit lack of advance
    return `${who} to ${to}`;
  }).filter(Boolean);
}

/* The whole event, as a sentence and the shorthand it came from. */
function describePlay(ev) {
  if (!ev) return { text: '', raw: ev, known: false };
  // ! ? # mark an exceptional or uncertain play; + and - a hard or softly hit
  // ball. The specification says all five can be safely ignored.
  const clean = ev.replace(/[!?#]/g, '');
  const dot = clean.indexOf('.');
  const head = (dot < 0 ? clean : clean.slice(0, dot)).replace(/[+\-]/g, '');
  const parts = head.split('/');
  const main = describeBasic(parts[0], parts.slice(1));
  const runners = describeAdvances(dot < 0 ? '' : clean.slice(dot + 1));
  if (!main) return { text: '', raw: ev, known: false };
  return { text: [main, ...runners].join('. ') + '.', raw: ev, known: true };
}

/* One row per play, grouped by half-inning. The shorthand is kept beside the
   English rather than thrown away: it is what Retrosheet actually recorded,
   it is what anyone checking the page against the source needs, and where the
   parser has nothing to say it is all there is. */
/* Under app.py the plays arrive as plain JSON and any browser can read them;
   only the docs/ build stores them compressed. */
const playsCanBeRead = () => !window.LocalAPI || window.LocalAPI.canReadPlays;

/* Retrosheet holds the place a change was made with an "NP" play and names the
   man arriving in the `sub` record after it. One record does two jobs, and the
   wording has to cover both: 14% of substitutions are men already in the game
   moving across -- 5,090 of the 8,395 left fielders in a sample of 177,053 --
   so "takes over" is used where "comes in" would be wrong that often. The
   pitcher keeps "comes in": 236 of his 76,670 are moves.

   Who left is not here, because the record does not say. Working it out would
   mean replaying the lineup and every change before this one to see who held
   the slot, which goes quietly wrong on double switches. */
const SUB_ROLE = {
  1: 'comes in to pitch', 2: 'takes over at catcher',
  3: 'takes over at first base', 4: 'takes over at second base',
  5: 'takes over at third base', 6: 'takes over at shortstop',
  7: 'takes over in left field', 8: 'takes over in center field',
  9: 'takes over in right field', 10: 'takes over as the designated hitter',
  11: 'pinch-hits', 12: 'pinch-runs',
};

const subRole = s => SUB_ROLE[s.pos] || 'enters the game';
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);

function playsHTML(plays, sides) {
  if (!plays.length) return '<p class="empty">No plays recorded.</p>';
  const out = [];
  let half = null;
  for (const p of plays) {
    const key = p.inning + '|' + p.side;
    if (key !== half) {
      half = key;
      out.push(`<h5>${p.side === 0 ? 'Top' : 'Bottom'} ${ordinal(p.inning)} — ${
        esc(sides[p.side])}</h5>`);
    }
    const d = describePlay(p.event);
    const subs = p.subs || [];
    /* An NP row on its own reads "No play" beside the name of whoever was
       batting before the change: a line that says nothing and points at the
       wrong man. Where a substitution was made at it, that is what the row
       says instead, and it leads with the man arriving rather than the man he
       interrupted. Where a sub follows a real play -- 3 times in 177,053 -- it
       is added to that play rather than replacing it. */
    const lead = subs.length && /^NP/.test(p.event || '') ? subs[0] : null;
    /* The club, but only when the half-inning above names the other one. A
       pitching change is made while the other side bats, so "Comes in to
       pitch" under "Top 8th — San Francisco" reads as a Giant when Galvez was
       a Dodger. A pinch hitter needs no such help: the header is his side. */
    const said = subs.map(s => cap(
      (s === lead ? subRole(s) : `${s.name} ${subRole(s)}`)
      + (s.side !== p.side ? ` for ${sides[s.side]}` : '')) + '.');
    if (!lead && d.known) said.unshift(d.text);
    const text = said.join(' ');
    const who = lead || { person: p.batter, name: p.batterName };
    out.push(`<div class="play">${playerLink(who.person, who.name)}
      <span class="${text ? 'pbp-text' : 'pbp-text note'}">${
        text ? esc(text) : 'Not yet translated'}</span>
      <code class="pbp-raw">${esc(d.raw)}</code></div>`);
  }
  return out.join('');
}

// ------------------------------------------------------------------- player

/* The order a season's rounds are played in -- app.py's GAMETYPE_ORDER, so a
   career reads down the calendar. */
const TYPE_ORDER = ['regular', 'playoff', 'wildcard', 'division', 'lcs',
                    'championship', 'worldseries', 'allstar', 'exhibition'];
const typeRank = t => (TYPE_ORDER.indexOf(t) + 1) || 99;

/* Column orders follow baseball-records, so the two front ends put the same
   number in the same place; the tail of each line is what this database has
   and Lahman does not. */
/* The rates lead, the way the pitching line leads with W-L-ERA: a batting
   line is read for the slash first and the counting stats after it. */
const BAT_HEAD = [{ t: 'Season' }, { t: 'Team', l: 1 }, { t: 'AVG' }, { t: 'OBP' },
  { t: 'SLG' }, { t: 'OPS' }, { t: 'G' }, { t: 'AB' }, { t: 'R' }, { t: 'H' },
  { t: '2B' }, { t: '3B' }, { t: 'HR' }, { t: 'RBI' }, { t: 'SB' }, { t: 'CS' },
  { t: 'BB' }, { t: 'SO' }, { t: 'GIDP' }, { t: 'HBP' }, { t: 'SH' }, { t: 'SF' }];

const PIT_HEAD = [{ t: 'Season' }, { t: 'Team', l: 1 }, { t: 'W' }, { t: 'L' },
  { t: 'ERA' }, { t: 'G' }, { t: 'GS' }, { t: 'CG' }, { t: 'SHO' }, { t: 'SV' },
  { t: 'IP' }, { t: 'H' }, { t: 'R' }, { t: 'ER' }, { t: 'HR' }, { t: 'BB' },
  { t: 'SO' }, { t: 'HBP' }, { t: 'WP' }, { t: 'BF' }, { t: 'WHIP' }];

const FLD_HEAD = [{ t: 'Season' }, { t: 'Pos', l: 1 }, { t: 'G' }, { t: 'Inn' },
  { t: 'PO' }, { t: 'A' }, { t: 'E' }, { t: 'DP' }, { t: 'TP' }, { t: 'PB' },
  { t: 'FPCT' }];

const MGR_HEAD = [{ t: 'Season' }, { t: 'Team', l: 1 }, { t: 'W' }, { t: 'L' },
  { t: 'T' }, { t: 'PCT' }, { t: 'G' }];

/* A man works one position in a game, so the positions sum to the games. The
   outfield pair only ever fills for a six-man crew, and the columns stand
   empty for the two-man crews of before 1912 -- which is the record, not a
   gap in it. */
const UMP_HEAD = [{ t: 'Season' }, { t: 'G' }, { t: 'HP' }, { t: '1B' },
  { t: '2B' }, { t: '3B' }, { t: 'LF' }, { t: 'RF' }];

/* Each line twice over: once for a season, once for the totals row, where the
   rates have to be recomputed from the summed counts rather than averaged. */
const batLine = (r, label) => [
  label ?? r.season, label ? '' : teamLink(r.team, r.season, r.teamName),
  avg(r.h, r.ab), rate3(obpOf(r)), rate3(slgOf(r)), rate3(opsOf(r)),
  n(r.g), n(r.ab), n(r.r), n(r.h), n(r.d), n(r.t), n(r.hr), n(r.rbi),
  n(r.sb), n(r.cs), n(r.bb), n(r.so),
  n(r.gidp), n(r.hbp), n(r.sh), n(r.sf)];

const pitLine = (r, label) => [
  label ?? r.season, label ? '' : teamLink(r.team, r.season, r.teamName),
  n(r.w), n(r.l), era(r.er, r.outs), n(r.g), n(r.gs), n(r.cg), n(r.sho), n(r.sv),
  ip(r.outs), n(r.h), n(r.r), n(r.er), n(r.hr), n(r.bb), n(r.so),
  n(r.hbp), n(r.wp), n(r.bfp), rate2(whipOf(r))];

const fldLine = (r, label) => [
  label ?? r.season, label ? '' : esc(r.position),
  n(r.g), ip(r.outs), n(r.po), n(r.a), n(r.e), n(r.dp), n(r.tp), n(r.pb),
  rate3(fpctOf(r))];

// Ties are not a rounding error in the early game -- McGraw's 1899 has four --
// so they get a column, and the percentage is of decisions, as it is recorded.
const mgrLine = (r, label) => [
  label ?? r.season, label ? '' : teamLink(r.team, r.season, r.teamName),
  n(r.w), n(r.l), n(r.t),
  rate3((r.w || 0) + (r.l || 0) ? (r.w || 0) / ((r.w || 0) + (r.l || 0)) : null),
  n(r.g)];

const umpLine = (r, label) => [
  label ?? r.season, n(r.g), n(r.hp), n(r.b1), n(r.b2), n(r.b3),
  n(r.lf), n(r.rf)];

/* One table per kind of game. Splitting them is not a nicety: 3,835 Negro
   League games carry gametype 'negro' rather than 'regular', so a page that
   showed the regular season alone showed Josh Gibson -- 495 games, 633 hits,
   116 home runs -- an empty table, and Satchel Paige half a career. */
function statSections(list, head, line) {
  const by = new Map();
  for (const r of list) {
    if (!by.has(r.gametype)) by.set(r.gametype, []);
    by.get(r.gametype).push(r);
  }
  const groups = [...by].sort((a, b) => typeRank(a[0]) - typeRank(b[0]));
  const bare = groups.length === 1 && groups[0][0] === 'regular';
  return groups.map(([type, rs]) => {
    const totals = {};
    for (const k of ['g', 'ab', 'r', 'h', 'd', 't', 'hr', 'rbi', 'sb', 'cs', 'bb',
      'so', 'gidp', 'hbp', 'sh', 'sf', 'outs', 'er', 'bfp', 'wp', 'w', 'l', 'sv',
      'gs', 'cg', 'sho', 'po', 'a', 'e', 'dp', 'tp', 'pb',
      'hp', 'b1', 'b2', 'b3', 'lf', 'rf']) totals[k] = colSum(rs, k);
    const rows = rs.map(r => ({ cells: line(r) }));
    rows.push({ _cls: 'totals',
                cells: line(totals, type === 'regular' ? 'Career' : 'Total') });
    return (bare ? '' : `<h4>${esc(META.gametypes[type] || type)}</h4>`)
      + table(head, rows);
  }).join('');
}

async function viewPlayer(parts, q) {
  const id = parts[0];
  if (parts[1] === 'games') return viewPlayerGames(id, q);
  /* The log used to hang off the bottom of this page under ?season=. It is a
     page of its own now, and the old address still points at it rather than
     at a player page with the season silently ignored. */
  const season = q.get('season');
  if (season) return location.replace(`#/player/${id}/games?season=${season}`);

  const d = await api('/player/' + id);
  const p = d.person;

  const bio = [];
  const add = (k, v) => { if (v) bio.push(`<div><span class="k">${k}</span> ${v}</div>`); };
  add('Born', [niceDate(p.birthdate), [p.birth_city, p.birth_state, p.birth_country]
    .filter(Boolean).join(', ')].filter(Boolean).join(' — '));
  if (p.deathdate) add('Died', niceDate(p.deathdate));
  add('Bats / Throws', [p.bats, p.throws].filter(Boolean).join(' / '));
  add('Height / Weight', [p.height ? `${Math.floor(p.height / 12)}′${p.height % 12}″` : '',
    p.weight ? p.weight + ' lb' : ''].filter(Boolean).join(', '));
  add('Debut', p.play_debut ? niceDate(p.play_debut) : '');
  add('Last game', p.play_last ? niceDate(p.play_last) : '');
  /* The other three ways to spend a career. Coaching is dates and nothing
     else -- no game file names a coach -- so for the 1,903 of them this line
     is the whole record, which is reason enough to print it. */
  const span = (a, b) => !a ? ''
    : niceDate(a) + (b && b !== a ? ' – ' + niceDate(b) : '');
  add('Managed', span(p.mgr_debut, p.mgr_last));
  add('Coached', span(p.coach_debut, p.coach_last));
  add('Umpired', span(p.ump_debut, p.ump_last));
  // Hall of Fame membership is the pill next to his name; a row saying
  // "Hall of Fame: HOF" repeats it without adding anything.

  const bat = statSections(d.batting, BAT_HEAD, batLine);
  const pit = statSections(d.pitching, PIT_HEAD, pitLine);
  const fld = statSections(d.fielding, FLD_HEAD, fldLine);
  const mgr = statSections(d.managing || [], MGR_HEAD, mgrLine);
  const ump = statSections(d.umpiring || [], UMP_HEAD, umpLine);

  /* A man who never came to the plate gets no batting table. Retrosheet
     writes a batting line for everyone who was in the game, so a modern
     relief pitcher otherwise collects a season row of zeroes for every year
     of his career. Asking for a plate appearance -- not merely a line --
     keeps every pitcher who did bat, which before the DH is all of them. */
  const anyPA = d.batting.some(r =>
    (r.ab || 0) + (r.bb || 0) + (r.hbp || 0) + (r.sh || 0) + (r.sf || 0) > 0);
  const pitcherFirst = (colSum(d.pitching, 'outs') || 0) > 0
                     && (colSum(d.batting, 'ab') || 0) < 500;
  const batting = (bat && anyPA) ? `<h3>Batting</h3>${bat}` : '';
  const pitching = pit ? `<h3>Pitching</h3>${pit}` : '';

  /* Directly under the bio, above the season tables. Every game he took part
     in is the thing this database has that a season-totals one does not, and
     it had been sitting below twenty seasons of tables where it had to be
     scrolled past everything to be found. */
  const log = d.seasons.length
    ? `<h3>Game log</h3>
       <div class="controls">
         <label>Season<select id="gl-season">
           <option value="">— pick a season —</option>${seasonOptions(d.seasons)}
         </select></label>
       </div>`
    /* A coach, and nothing else. Retrosheet's biography file has his dates but
       no game file names a coach, so there is no season to offer and saying so
       beats an empty picker. */
    : `<h3>Game log</h3><p class="empty">No games on file — the game files
       record players, managers and umpires, but not coaches.</p>`;

  app.innerHTML = `
    <h2>${esc(p.name)}${p.hof ? '<span class="pill alt">HOF</span>' : ''}</h2>
    <div class="meta-grid">${bio.join('')}</div>
    ${log}
    ${pitcherFirst ? pitching + batting : batting + pitching}
    ${fld ? `<h3>Fielding</h3>${fld}` : ''}
    ${mgr ? `<h3>Managing</h3>${mgr}` : roleGap(p.mgr_debut, 'a manager')}
    ${ump ? `<h3>Umpiring</h3>${ump}` : roleGap(p.ump_debut, 'an umpire')}`;

  const sel = document.getElementById('gl-season');
  if (sel) sel.addEventListener('change', e => {
    if (e.target.value) location.hash = `#/player/${id}/games?season=${e.target.value}`;
  });
}

const seasonOptions = (seasons, picked) => seasons.map(y =>
  `<option value="${y}"${String(y) === String(picked) ? ' selected' : ''}>${y}</option>`
).join('');

/* Two files that do not quite agree. The biography file gives Ruth managerial
   dates; no game in the game files names him as one, and 153 of the 1,007
   managers and 70 of the 2,369 umpires are in the same position. Saying so is
   better than a bio line promising a record that never appears below it. */
const roleGap = (debut, what) => !debut ? ''
  : `<p class="note">Retrosheet's biography file records him as ${what}, but no
     game in the files names him one.</p>`;

/* The log as a page of its own, with the picker carried along so a reader
   working through a career moves season to season without going back for the
   control each time. */
async function viewPlayerGames(id, q) {
  const season = q.get('season') || '';
  const d = await api(`/player/${id}/games?season=${season}`);
  const name = d.person ? d.person.name : id;

  app.innerHTML = `
    <div class="crumb">${link('#/player/' + id, '← ' + name)}</div>
    <h2>${esc(season)} game log</h2>
    <div class="controls">
      <label>Season<select id="gl-season">${
        seasonOptions(d.seasons || [], season)}</select></label>
    </div>
    <div id="gamelog"></div>`;

  const sel = document.getElementById('gl-season');
  if (sel) sel.addEventListener('change', e => {
    location.hash = `#/player/${id}/games?season=${e.target.value}`;
  });
  renderGameLog(d, season);
}

/* One table per way he took part. A hitter's log has no business carrying
   empty IP and ER columns, and a two-way player -- Ruth in 1918, Ohtani now --
   gets both, each with the stats that belong to it, rather than one wide row
   half of which is blank. */
/* The way out of a log row is the box pill, as it is in the games tab, and the
   date beside it is data. A date that was a link read as though it would list
   that day -- which is what a date does one tab over -- when it went to the one
   game. The pill says what it opens and says whether there is a box score to
   open, which the date could never do. The doubleheader number rides on it for
   the same reason it does there: two rows of one date need telling apart. */
const logGameLink = g => boxLinkHTML(g, g.number && g.number !== '0'
  ? ' ' + g.number : '');
const LOG_DATE = { t: 'Box', l: 1 };

function renderGameLog(d, season) {
  const common = g => [
    logGameLink(g),
    niceDate(g.date),
    esc(g.teamName || g.team),
    (g.side === 0 ? 'at ' : 'vs ') + esc(g.oppName),
    `${n(g.vis_score)}–${n(g.home_score)}`,
  ];
  const HEAD = [LOG_DATE, { t: 'Date', l: 1 }, { t: 'Team', l: 1 },
                { t: 'Opponent', l: 1 }, { t: 'Score' }];

  /* A season's games include October. Totalling the World Series into the
     regular-season line is the same mistake the team record made, and this is
     where it would show up on a player's page, so each game type gets its own
     section and its own totals -- and that goes for the games he managed as
     much as the ones he played, or Lasorda's 1977 reads 103-69 rather than
     the 98-64 he is credited with.

     All three roles bucket together, because a man can hold more than one in
     a season: a player-manager, of whom there are plenty before the war, and
     Rose as late as 1986. Within a round they are named only if he did in
     fact do more than one thing. */
  const byType = new Map();
  const bucket = t => {
    if (!byType.has(t)) byType.set(t, { play: [], mgr: [], ump: [] });
    return byType.get(t);
  };
  for (const g of d.games) bucket(g.gametype).play.push(g);
  for (const g of (d.managed || [])) bucket(g.gametype).mgr.push(g);
  for (const g of (d.umpired || [])) bucket(g.gametype).ump.push(g);
  const types = [...byType].sort((a, b) => typeRank(a[0]) - typeRank(b[0]));

  const out = [];
  for (const [type, b] of types) {
    const play = logTables(b.play, common, HEAD);
    const roles = (play ? 1 : 0) + (b.mgr.length ? 1 : 0) + (b.ump.length ? 1 : 0);
    const parts = [];
    if (play) parts.push((roles > 1 ? '<h5>Playing</h5>' : '') + play);
    if (b.mgr.length) {
      const rows = b.mgr.map(g => ({ cells: [
        logGameLink(g),
        niceDate(g.date),
        esc(g.teamName || g.team),
        (g.side === 0 ? 'at ' : 'vs ') + esc(g.oppName),
        `${n(g.vis_score)}–${n(g.home_score)}`,
        g.result ? `<span class="result-${g.result}">${g.result}</span>` : '',
      ] }));
      const tally = k => b.mgr.filter(g => g.result === k).length;
      rows.push({ _cls: 'totals', cells: ['', `${b.mgr.length} games`, '', '', '',
        `${tally('W')}–${tally('L')}${tally('T') ? '–' + tally('T') : ''}`] });
      parts.push((roles > 1 ? '<h5>Managing</h5>' : '') + table(
        [LOG_DATE, { t: 'Date', l: 1 }, { t: 'Team', l: 1 },
         { t: 'Opponent', l: 1 }, { t: 'Score' }, { t: 'Result' }], rows));
    }
    if (b.ump.length) {
      const rows = b.ump.map(g => ({ cells: [
        logGameLink(g),
        niceDate(g.date),
        `${esc(g.visName)} at ${esc(g.homeName)}`,
        `${n(g.vis_score)}–${n(g.home_score)}`,
        esc(g.position),
      ] }));
      rows.push({ _cls: 'totals', cells: ['', `${b.ump.length} games`, '', '', ''] });
      parts.push((roles > 1 ? '<h5>Umpiring</h5>' : '') + table(
        [LOG_DATE, { t: 'Date', l: 1 }, { t: 'Game', l: 1 }, { t: 'Score' },
         { t: 'Pos' }], rows));
    }
    if (!parts.length) continue;
    out.push((types.length > 1
      ? `<h4>${esc(META.gametypes[type] || type)}</h4>` : '') + parts.join(''));
  }

  document.getElementById('gamelog').innerHTML = out.length
    ? `<p class="note">${d.total} games in ${season}.</p>` + out.join('')
    : '<p class="empty">No games that season.</p>';
}

/* The batting and pitching tables for one set of games. */
/* A plate appearance, not merely a batting line. Retrosheet writes one for
   every man who was in the game, so a relief pitcher in the DH era collects a
   row of zeroes for each outing -- 69 of them for Bednar in 2025, and
   1,019,741 rows across the database that record no time at bat at all.
   Listing those as a batting log is listing nothing. */
const hadPA = g => (g.ab || 0) + (g.bb || 0) + (g.hbp || 0)
                 + (g.sh || 0) + (g.sf || 0) > 0;

function logTables(games, common, HEAD) {
  const batted = games.filter(hadPA);
  const pitched = games.filter(g => g.p_outs != null);
  // Lead with whichever he mostly was. A pitcher's log should open with his
  // pitching; Ohtani's, where he batted in 176 games and pitched in 18,
  // should not.
  const pitcherFirst = pitched.length > games.length / 2;

  const batTotal = k => batted.reduce((a, g) => a + (g[k] || 0), 0);
  const batRows = batted.map(g => ({
    cells: [...common(g), n(g.ab), n(g.r), n(g.h), n(g.d), n(g.t), n(g.hr),
      n(g.rbi), n(g.bb), n(g.so), n(g.sb)],
  }));
  if (batRows.length) {
    batRows.push({ _cls: 'totals', cells: ['', `${batted.length} games`, '', '', '',
      batTotal('ab'), batTotal('r'), batTotal('h'), batTotal('d'), batTotal('t'),
      batTotal('hr'), batTotal('rbi'), batTotal('bb'), batTotal('so'), batTotal('sb')] });
  }

  const pitTotal = k => pitched.reduce((a, g) => a + (g[k] || 0), 0);
  const pitRows = pitched.map(g => ({
    cells: [...common(g), g.ip ?? '', n(g.p_h), n(g.p_r), n(g.p_er), n(g.p_bb),
      n(g.p_so), n(g.p_hr)],
  }));
  if (pitRows.length) {
    pitRows.push({ _cls: 'totals', cells: ['', `${pitched.length} games`, '', '', '',
      ip(pitTotal('p_outs')), pitTotal('p_h'), pitTotal('p_r'), pitTotal('p_er'),
      pitTotal('p_bb'), pitTotal('p_so'), pitTotal('p_hr')] });
  }

  const both = batRows.length && pitRows.length;
  const batBlock = batRows.length
    ? (both ? '<h5>Batting</h5>' : '') + table(
      [...HEAD, { t: 'AB' }, { t: 'R' }, { t: 'H' }, { t: '2B' }, { t: '3B' },
       { t: 'HR' }, { t: 'RBI' }, { t: 'BB' }, { t: 'SO' }, { t: 'SB' }], batRows)
    : '';
  const pitBlock = pitRows.length
    ? (both ? '<h5>Pitching</h5>' : '') + table(
      [...HEAD, { t: 'IP' }, { t: 'H' }, { t: 'R' }, { t: 'ER' }, { t: 'BB' },
       { t: 'SO' }, { t: 'HR' }], pitRows)
    : '';
  return pitcherFirst ? pitBlock + batBlock : batBlock + pitBlock;
}

// --------------------------------------------------------------------- team

async function viewTeam(parts, q) {
  const code = parts[0];
  const season = q.get('season');
  if (!season) {
    const d = await api('/team/' + code);
    const rows = d.seasons.map(s => ({
      cells: [link(`#/team/${code}?season=${s.season}`, s.season), s.n] }));
    app.innerHTML = `<h2>${esc(code)}</h2>` + table(
      [{ t: 'Season', l: 1 }, { t: 'Games' }], rows);
    return;
  }
  const d = await api(`/team/${code}?season=${season}`);
  const info = d.info || {};
  const rows = d.games.map(g => ({
    cells: [
      gameLink(g.id, niceDate(g.date)),
      g.atHome ? 'vs' : 'at',
      teamLink(g.opp, season, g.oppName),
      `${n(g.us)}–${n(g.them)}`,
      g.result ? `<span class="result-${g.result}">${g.result}</span>` : '',
      g.record || `<span class="note">${esc(META.gametypes[g.gametype] || g.gametype)}</span>`,
      g.attendance ? g.attendance.toLocaleString() : '',
    ],
  }));
  const recs = Object.entries(d.records || {}).map(([k, v]) =>
    `${esc(v.label)} ${v.w}–${v.l}${v.t ? '–' + v.t : ''}`).join(' · ');
  const roster = d.roster.map(r => ({
    cells: [playerLink(r.person, r.name), esc(r.pos || ''),
      esc([r.bats, r.throws].filter(Boolean).join('/'))] }));

  app.innerHTML = `
    <div class="crumb">${link('#/teams?season=' + season, season + ' clubs')}</div>
    <h2>${esc([info.city, info.nickname].filter(Boolean).join(' ') || code)} — ${season}</h2>
    <p class="note">${recs}</p>
    <div class="two-col">
      <div><h3>Schedule</h3>${table(
        [{ t: 'Date', l: 1 }, { t: '', l: 1 }, { t: 'Opponent', l: 1 }, { t: 'Score' },
         { t: '' }, { t: 'Record', l: 1 }, { t: 'Att' }], rows)}</div>
      <div><h3>Roster (${d.roster.length})</h3>${table(
        [{ t: 'Player', l: 1 }, { t: 'Pos', l: 1 }, { t: 'B/T', l: 1 }], roster)}</div>
    </div>`;
}

async function viewTeams(_, q) {
  const season = q.get('season') || META.lastSeason;
  const d = await api('/teams?season=' + season);
  const years = [];
  for (let y = META.lastSeason; y >= META.firstSeason; y--) years.push(y);
  // The All-Star squads are not clubs and are kept out of the league lists,
  // where sorting by city drops "American League All-Stars" above Anaheim.
  // They keep a section of their own rather than being hidden: it is the only
  // way to reach the All-Star rosters from here.
  const byLeague = {};
  d.teams.filter(t => !t.allstar).forEach(t => {
    const k = t.league || 'League not recorded';
    (byLeague[k] = byLeague[k] || []).push(t);
  });
  const clubTable = ts => table([{ t: 'Club', l: 1 }, { t: 'Games' }],
    ts.map(t => ({ cells: [teamLink(t.id, season, `${t.city} ${t.nickname}`), t.n] })));
  let blocks = Object.entries(byLeague)
    .map(([lg, ts]) => `<h3>${esc(lg)}</h3>${clubTable(ts)}`).join('');
  const squads = d.teams.filter(t => t.allstar);
  if (squads.length) {
    blocks += `<h3>All-Star squads</h3>`
      + `<p class="note">Assembled for the one game; not clubs.</p>`
      + clubTable(squads);
  }
  app.innerHTML = `
    <div class="controls"><label>Season<select id="t-season">${years.map(y =>
      `<option${y == season ? ' selected' : ''}>${y}</option>`).join('')}</select></label></div>
    <h2>Clubs in ${season}</h2>${blocks}`;
  document.getElementById('t-season').addEventListener('change', e => {
    location.hash = '#/teams?season=' + e.target.value;
  });
}

// -------------------------------------------------------------- notable games

/* The way in for a reader who does not already have a date in mind. The Games
   tab answers "what happened that day" and a player page answers "what did he
   do"; this answers "show me something worth reading".

   Every row is derived here, not copied from a list. Retrosheet publishes its
   own -- nohit_chrono.htm, perfect.htm, cycles.htm -- but as web pages, and
   the two were reconciled row by row on 2026-08-12 rather than trusted: their
   pages carry games our box scores contradict, ours carry games their pages
   have never listed, and the note under each table says so rather than
   claiming to be the record. */
const NOTABLE_SOURCE = {
  plays: ['', ''],
  box: ['box score', 'No play-by-play for this game, so the box score is the '
        + 'whole of the evidence: it cannot see a man who reached on an error.'],
  log: ['game log only', 'No box score for this game at all — the game log has '
        + 'the result and the team totals, and nobody is named.'],
};

async function viewNotable(_, q) {
  const d = await api('/notable');
  const asked = q.get('kind');
  const kind = d.kinds.some(k => k.id === asked) ? asked : d.kinds[0].id;
  const meta = d.kinds.find(k => k.id === kind);

  const rows = d.rows[kind].map(r => {
    // A pill only where the row rests on less than the rest of its table: on
    // the box score alone in a list the play-by-play otherwise settles, or on
    // a game log with no box score behind it at all.
    const weak = r.source === 'log' || (kind === 'perfect' && r.source === 'box');
    const [label, why] = NOTABLE_SOURCE[r.source] || ['', ''];
    return { cells: [
      gameLink(r.game, niceDate(r.date)),
      r.who.length ? r.who.map(w => playerLink(w.id, w.name)).join(', ')
        : '<span class="note">not recorded</span>',
      teamLink(r.team, r.season, r.teamName)
        + (weak ? ` <span class="pill quiet" title="${esc(why)}">${esc(label)}</span>` : ''),
      teamLink(r.opp, r.season, r.oppName),
      esc(r.score),
    ] };
  });

  app.innerHTML = `
    <h2>Games worth reading</h2>
    <div class="filters"><label>Kind <select id="n-kind">${d.kinds.map(k =>
      `<option value="${k.id}"${k.id === kind ? ' selected' : ''}>${esc(k.label)} (${
        k.n.toLocaleString()})</option>`).join('')}</select></label></div>
    <p class="note">${esc(meta.note)}</p>
    <p class="note">Derived from the box scores here, not taken from a list —
      so it reaches games no official list carries, and stops where the data
      does. Box scores start in 1897: Bobby Lowe's four home runs in 1894 and
      the two perfect games of 1880 cannot appear. The Federal League of
      1914–15 has no box scores at all, and the Negro Leagues are in.</p>
    ${table([{ t: 'Date', l: 1 }, { t: meta.id === 'nohit' || meta.id === 'perfect'
        ? 'Pitcher' : 'Batter', l: 1 }, { t: 'Club', l: 1 },
      { t: 'Against', l: 1 }, { t: 'Score' }], rows,
      { empty: 'Nothing of this kind in the data.' })}`;

  document.getElementById('n-kind').addEventListener('change', e => {
    location.hash = '#/notable?kind=' + e.target.value;
  });
}

// ---------------------------------------------------------------- day, park

/* The day view was a second way to read one date -- its own endpoint, its own
   columns for the same rows, and no filters. The calendar reaches the same day
   with the club and the round still applied, so this is now a redirect that
   keeps the old links working. A season is the calendar year in all 239,442
   games Retrosheet has, so the year is the season and nothing is lost.
   `replace`, not assignment: an added history entry would bounce the reader
   straight back here on the first press of Back. */
async function viewDay(parts) {
  const date = parts[0] || '';
  location.replace(`#/games?season=${date.slice(0, 4)}&date=${date}`);
}

async function viewPark(parts) {
  const d = await api('/park/' + parts[0]);
  const p = d.park;
  const rows = d.bySeason.map(s => ({
    cells: [link(`#/games?season=${s.season}&park=${p.id}`, s.season), s.n,
      s.avg_att ? Math.round(s.avg_att).toLocaleString() : ''] }));
  app.innerHTML = `
    <h2>${esc(p.name)}</h2>
    <div class="meta-grid">
      <div><span class="k">Where</span> ${esc([p.city, p.state].filter(Boolean).join(', '))}</div>
      ${p.aka ? `<div><span class="k">Also known as</span> ${esc(p.aka)}</div>` : ''}
      <div><span class="k">Games</span> ${d.span.n.toLocaleString()}, ${d.span.a}–${d.span.b}</div>
    </div>
    ${p.notes ? `<p class="note">${esc(p.notes)}</p>` : ''}
    ${table([{ t: 'Season', l: 1 }, { t: 'Games' }, { t: 'Avg attendance' }], rows)}`;
}

// ------------------------------------------------------------------- search

let searchTimer = null;
let searchToken = 0;

async function viewSearch(_, q) {
  const term = q.get('q') || '';
  app.innerHTML = `
    <div class="controls">
      <label>Name<input type="search" id="s-q" value="${esc(term)}"
             placeholder="Ruth, Mays, Aparicio…" autocomplete="off" autofocus></label>
    </div>
    <div id="results"></div>`;
  const box = document.getElementById('s-q');

  /* Results as you type. The hash is kept in step with replaceState rather
     than by assignment: setting location.hash fires hashchange, which would
     re-run the router, rebuild this view and take the cursor out of the box
     on every keystroke. */
  const run = async (text) => {
    const mine = ++searchToken;
    const out = document.getElementById('results');
    if (text.length < 2) {
      out.innerHTML = text
        ? '<p class="note">Keep typing — two letters or more.</p>' : '';
      return;
    }
    const d = await api('/search?q=' + encodeURIComponent(text));
    if (mine !== searchToken) return;   // a later keystroke already answered
    const rows = d.results.map(r => ({
      cells: [playerLink(r.id, r.name) + (r.hof ? '<span class="pill alt">HOF</span>' : ''),
        esc(r.roles.join(', ')),
        r.debut ? r.debut.slice(0, 4) : '',
        r.lastGame ? r.lastGame.slice(0, 4) : '',
        r.games ? r.games.toLocaleString() : ''],
    }));
    out.innerHTML = table(
      [{ t: 'Name', l: 1 }, { t: 'Role', l: 1 }, { t: 'From' }, { t: 'To' },
       { t: 'Games' }], rows, { empty: 'Nobody by that name.' });
  };

  box.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const text = box.value.trim();
    history.replaceState(null, '',
      '#/search' + (text ? '?q=' + encodeURIComponent(text) : ''));
    searchTimer = setTimeout(() => run(text), 250);
  });
  box.addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(searchTimer); run(box.value.trim()); }
  });

  // Warm the name index while they are still typing the first letter, so the
  // first result set doesn't wait on a 2 MB download.
  if (window.LocalAPI) api('/search?q=__warm__').catch(() => {});
  if (term) run(term);
}

// -------------------------------------------------------------------- about

async function viewAbout() {
  app.innerHTML = `
    <h2>About</h2>
    <p class="note">Built from the Retrosheet data files. ${META.games.toLocaleString()}
      games, ${META.firstSeason}–${META.lastSeason};
      ${META.withBox.toLocaleString()} of them with a full box score and
      ${META.withPlays.toLocaleString()} with play-by-play.</p>
    <p class="note"><strong>Every play, where Retrosheet recorded one.</strong>
      A game marked <span class="pill quiet">plays</span> carries an account of
      each plate appearance — 18,263,689 of them — and its page will read them
      out: “S8/L.2-H” becomes “Single to center field. Runner on second
      scored.” The shorthand stays beside the English, because it is what
      Retrosheet actually wrote, and where the expansion has nothing to say it
      is all there is.</p>
    <p class="note">Where the ball went is read too, from the codes Retrosheet
      writes inside the play — “F78XD” is an extra-deep drive to left-center.
      From 1989 nearly every batted ball carries one; before that it is patchy
      and not in a straight line — 26% of them in 1985, 2.4% in 1950, 24% in
      1925 — so an older game reading without one is the source being silent,
      not the page losing it.</p>
    <p class="note">What the plays don't carry here: pitch sequences — ball,
      called strike, foul, in play — are in the files from 1988 but are not
      read in, being two fifths of the bytes for the shape of a plate
      appearance rather than its result. Substitutions are shown, but name only
      the man arriving. Retrosheet's record is written that way, and deducing
      the man he replaced would mean replaying the lineup, which goes quietly
      wrong on double switches.</p>

    <h3>What the data can and can't say</h3>
    <p class="note">Game results go back to 1871, but the nineteenth-century game
      logs carry only the result — no batting lines at all before 1897. Per-player
      box scores are complete for the National League from 1897 and for both
      leagues from the American League's first season in 1901. The play-by-play
      starts later: complete for the American and National Leagues from 1908,
      and before that only 33 scattered games back to 1900. The Federal League
      of 1914–15 has no box scores at all — 1,243 games with the result and the
      team's totals and no player lines — so a career that passed through it
      skips those seasons: Benny Kauff led the league twice, and his page goes
      1912, then 1916.
      Negro League games are not in the game logs at all; their records here are
      built from the box-score files, and Retrosheet notes that most were deduced
      from newspaper accounts.</p>
    <p class="note">Retrosheet publishes no season or career totals. Every total
      on this site is summed from the individual game lines, so where Retrosheet's
      box scores differ from the official record — and Retrosheet documents that
      they sometimes do — the totals here will differ too. That is a property of
      the source, not an error in the arithmetic.</p>`;
  /* No licence section here. Retrosheet's notice is in the footer of
     index.html, which is outside #app and so stands under every view,
     including this one -- repeating it in the page body showed it twice. */
}

// --------------------------------------------------------------------- boot

(async function () {
  try {
    META = await api('/meta');
    document.getElementById('subtitle').textContent =
      `${META.games.toLocaleString()} games, ${META.firstSeason}–${META.lastSeason}`;
  } catch (e) {
    app.innerHTML = `<p class="empty">Can’t reach the server: ${esc(e.message)}</p>`;
    return;
  }
  window.addEventListener('hashchange', route);
  route();
})();
