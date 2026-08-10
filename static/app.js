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

function era(er, outs) {
  if (!outs) return '';
  return (er * 27 / outs).toFixed(2);
}

function ip(outs) {
  if (outs === null || outs === undefined) return '';
  return Math.floor(outs / 3) + '.' + (outs % 3);
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
  return parts.join('/') + '|' + ['season', 'team', 'gametype', 'park', 'q']
    .map(k => q.get(k) || '').join('|');
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

// What else Retrosheet holds, not something to click: the play-by-play is on
// file for 204,643 games but isn't a view yet.
const onFileHTML = g =>
  (g.has_pbp ? '<span class="pill quiet" title="Retrosheet has a'
    + ' pitch-by-pitch account of this game. Not shown here yet.">plays</span>' : '');

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
function gamesHash({ season, team, gametype, park, date, was }) {
  const p = new URLSearchParams({ season });
  if (team) p.set('team', team);
  if (gametype) p.set('gametype', gametype);
  const sameSeason = was === undefined || String(season) === String(was);
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

  const teams = (await api('/teams?season=' + season)).teams;

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
  const narrow = !!team || !!park || (gametype !== '' && gametype !== 'regular');
  const wantList = !!date || narrow;
  /* 400 covers the widest of those with room to spare, and asking for none is
     what keeps the calendar-only view from putting rows on the wire that
     nothing is going to render. */
  const params = new URLSearchParams({ season, limit: wantList ? 400 : 0 });
  if (team) params.set('team', team);
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
      <label>Club<select id="f-team">${teamOpts}</select></label>
      ${seasonTypes.length > 1
        ? `<label>Type<select id="f-type">${typeOpts}</select></label>` : ''}
      ${park ? `<label>Park<span class="parkfilter">${esc(parkName)}<a
        href="${gamesHash({ season, team, gametype, date: selected })}"
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
        ? seasonGamesHTML(data.games, data.total, { season, team, gametype, park })
        : ''}`;

  const go = () => {
    const t = document.getElementById('f-type');
    location.hash = gamesHash({
      season: val('f-season'), team: val('f-team'), gametype: t ? t.value : '',
      park, date: selected, was: season,
    });
  };
  ['f-season', 'f-team', 'f-type'].forEach(id => {
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
        season, team, gametype, park,
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
   need the play-by-play, and this build reads the box-score layer. */
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
    // Home runs carry the inning, the pitcher and how many were aboard. Older
    // seasons have no itemised events, so fall back to the batting lines.
    const hrs = byKind.hr || [];
    add('HR', hrs.length
      ? hrs.map(e => {
        const on = e.on ? `, ${e.on} on` : '';
        const off = e.playerLast?.[1] ? ` off ${e.playerLast[1]}` : '';
        return `${e.playerLast?.[0] || e.playerNames[0]} (${ordinal(e.inning)}${off}${on})`;
      })
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
          + ' account of this game. This app doesn\'t show it yet.">'
          + 'play-by-play on file</span>'
        : ''}</div>
    </div>
    <p class="note">${niceDate(g.date)}${g.number !== '0' ? ` — game ${g.number} of a doubleheader` : ''}</p>
    ${lineScoreHTML(g)}
    ${sides.map(s => `<h3>${esc(s.name)}</h3>${battingTable(s.bat)}${
      pitchingTable(s.pit, decisions)}`).join('')}
    ${boxSummaryHTML(d.batting, d.pitching, d.events, d.teamBox,
                     [g.visName, g.homeName])}
    ${gameInfoHTML(g, d.park, p, d.pitching)}`;
}

// ------------------------------------------------------------------- player

async function viewPlayer(parts, q) {
  const id = parts[0];
  const d = await api('/player/' + id);
  const p = d.person;
  const season = q.get('season') || '';

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
  // Hall of Fame membership is the pill next to his name; a row saying
  // "Hall of Fame: HOF" repeats it without adding anything.

  const reg = r => r.gametype === 'regular';
  const batRows = d.batting.filter(reg).map(r => ({
    cells: [r.season, teamLink(r.team, r.season, r.teamName), r.g, n(r.ab), n(r.r), n(r.h),
      n(r.d), n(r.t), n(r.hr), n(r.rbi), n(r.bb), n(r.so), n(r.sb), avg(r.h, r.ab)],
  }));
  const bsum = k => d.batting.filter(reg).reduce((a, r) => a + (r[k] || 0), 0);
  if (batRows.length) batRows.push({ _cls: 'totals', cells: ['Career', '', bsum('g'),
    bsum('ab'), bsum('r'), bsum('h'), bsum('d'), bsum('t'), bsum('hr'), bsum('rbi'),
    bsum('bb'), bsum('so'), bsum('sb'), avg(bsum('h'), bsum('ab'))] });

  const pitRows = d.pitching.filter(reg).map(r => ({
    cells: [r.season, teamLink(r.team, r.season, r.teamName), r.g, ip(r.outs), n(r.h),
      n(r.r), n(r.er), n(r.bb), n(r.so), n(r.hr), era(r.er, r.outs)],
  }));
  const psum = k => d.pitching.filter(reg).reduce((a, r) => a + (r[k] || 0), 0);
  if (pitRows.length) pitRows.push({ _cls: 'totals', cells: ['Career', '', psum('g'),
    ip(psum('outs')), psum('h'), psum('r'), psum('er'), psum('bb'), psum('so'),
    psum('hr'), era(psum('er'), psum('outs'))] });

  const fldRows = d.fielding.filter(reg).map(r => ({
    cells: [r.season, r.position, r.g, ip(r.outs), n(r.po), n(r.a), n(r.e), n(r.dp)],
  }));

  /* A man who never came to the plate gets no batting table. Retrosheet
     writes a batting line for everyone who was in the game, so a modern
     relief pitcher otherwise collects a season row of zeroes for every year
     of his career. Asking for a plate appearance -- not merely a line --
     keeps every pitcher who did bat, which before the DH is all of them. */
  const anyPA = d.batting.filter(reg).some(r =>
    (r.ab || 0) + (r.bb || 0) + (r.hbp || 0) + (r.sh || 0) + (r.sf || 0) > 0);
  const pitcherFirst = psum('outs') > 0 && bsum('ab') < 500;
  const batting = (batRows.length && anyPA) ? `<h3>Batting</h3>${table(
    [{ t: 'Season' }, { t: 'Team', l: 1 }, { t: 'G' }, { t: 'AB' }, { t: 'R' }, { t: 'H' },
     { t: '2B' }, { t: '3B' }, { t: 'HR' }, { t: 'RBI' }, { t: 'BB' }, { t: 'SO' },
     { t: 'SB' }, { t: 'AVG' }], batRows)}` : '';
  const pitching = pitRows.length ? `<h3>Pitching</h3>${table(
    [{ t: 'Season' }, { t: 'Team', l: 1 }, { t: 'G' }, { t: 'IP' }, { t: 'H' }, { t: 'R' },
     { t: 'ER' }, { t: 'BB' }, { t: 'SO' }, { t: 'HR' }, { t: 'ERA' }], pitRows)}` : '';

  const years = d.seasons.map(y =>
    `<option value="${y}"${String(y) === season ? ' selected' : ''}>${y}</option>`).join('');

  app.innerHTML = `
    <h2>${esc(p.name)}${p.hof ? '<span class="pill alt">HOF</span>' : ''}</h2>
    <div class="meta-grid">${bio.join('')}</div>
    ${pitcherFirst ? pitching + batting : batting + pitching}
    ${fldRows.length ? `<h3>Fielding</h3>${table([{ t: 'Season' }, { t: 'Pos', l: 1 },
      { t: 'G' }, { t: 'Inn' }, { t: 'PO' }, { t: 'A' }, { t: 'E' }, { t: 'DP' }], fldRows)}` : ''}
    <h3>Game log</h3>
    <div class="controls">
      <label>Season<select id="gl-season">
        <option value="">— pick a season —</option>${years}</select></label>
    </div>
    <div id="gamelog"></div>`;

  document.getElementById('gl-season').addEventListener('change', e => {
    const p2 = new URLSearchParams();
    if (e.target.value) p2.set('season', e.target.value);
    location.hash = `#/player/${id}?${p2}`;
  });
  if (season) await renderGameLog(id, season);
  else document.getElementById('gamelog').innerHTML =
    '<p class="note">Pick a season to see every game he played in it.</p>';
}

/* One table per way he took part. A hitter's log has no business carrying
   empty IP and ER columns, and a two-way player -- Ruth in 1918, Ohtani now --
   gets both, each with the stats that belong to it, rather than one wide row
   half of which is blank. */
async function renderGameLog(id, season) {
  const d = await api(`/player/${id}/games?season=${season}`);
  const common = g => [
    gameLink(g.id, niceDate(g.date)),
    teamLink(g.team, g.season, g.teamName),
    (g.side === 0 ? 'at ' : 'vs ') + esc(g.oppName),
    `${n(g.vis_score)}–${n(g.home_score)}`,
  ];
  const HEAD = [{ t: 'Date', l: 1 }, { t: 'Team', l: 1 },
                { t: 'Opponent', l: 1 }, { t: 'Score' }];

  /* A season's games include October. Totalling the World Series into the
     regular-season line is the same mistake the team record made, and this is
     where it would show up on a player's page, so each game type gets its own
     section and its own totals. The games arrive in date order, so regular
     season leads and the rounds follow in the order they were played. */
  const byType = new Map();
  for (const g of d.games) {
    if (!byType.has(g.gametype)) byType.set(g.gametype, []);
    byType.get(g.gametype).push(g);
  }
  const out = [];
  for (const [type, games] of byType) {
    const html = logTables(games, common, HEAD);
    if (!html) continue;
    out.push(byType.size > 1
      ? `<h4>${esc(META.gametypes[type] || type)}</h4>${html}` : html);
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
    batRows.push({ _cls: 'totals', cells: [`${batted.length} games`, '', '', '',
      batTotal('ab'), batTotal('r'), batTotal('h'), batTotal('d'), batTotal('t'),
      batTotal('hr'), batTotal('rbi'), batTotal('bb'), batTotal('so'), batTotal('sb')] });
  }

  const pitTotal = k => pitched.reduce((a, g) => a + (g[k] || 0), 0);
  const pitRows = pitched.map(g => ({
    cells: [...common(g), g.ip ?? '', n(g.p_h), n(g.p_r), n(g.p_er), n(g.p_bb),
      n(g.p_so), n(g.p_hr)],
  }));
  if (pitRows.length) {
    pitRows.push({ _cls: 'totals', cells: [`${pitched.length} games`, '', '', '',
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
    <p class="note"><strong>The play-by-play is not shown here yet.</strong> Where a
      game is marked <span class="pill quiet">plays</span>, Retrosheet holds a
      pitch-by-pitch account of it — 18 million plays in all — but this app reads
      the game and box-score layers only. The badge says what exists, not what
      you can open.</p>

    <h3>What the data can and can't say</h3>
    <p class="note">Game results go back to 1871, but the nineteenth-century game
      logs carry only the result — no batting lines at all before 1898. Per-player
      box scores are complete for the American and National Leagues from 1898.
      The Federal League of 1914–15 has box scores but no play-by-play.
      Negro League games are not in the game logs at all; their records here are
      built from the box-score files, and Retrosheet notes that most were deduced
      from newspaper accounts.</p>
    <p class="note">Retrosheet publishes no season or career totals. Every total
      on this site is summed from the individual game lines, so where Retrosheet's
      box scores differ from the official record — and Retrosheet documents that
      they sometimes do — the totals here will differ too. That is a property of
      the source, not an error in the arithmetic.</p>

    <h3>Licence</h3>
    <p class="note">The information used here was obtained free of charge from and
      is copyrighted by Retrosheet. Interested parties may contact Retrosheet at
      <a href="https://www.retrosheet.org">www.retrosheet.org</a>.</p>`;
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
