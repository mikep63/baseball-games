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

function niceDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  return `${months[m - 1]} ${d}, ${y}`;
}

async function api(path) {
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
  window.scrollTo(0, 0);
}

// --------------------------------------------------------------- game finder

async function viewGames(_, q) {
  const season = q.get('season') || META.lastSeason;
  const team = q.get('team') || '';
  const gametype = q.get('gametype') || '';
  const date = q.get('date') || '';
  const park = q.get('park') || '';

  const teams = (await api('/teams?season=' + season)).teams;
  const params = new URLSearchParams({ season, limit: 400 });
  if (team) params.set('team', team);
  if (gametype) params.set('gametype', gametype);
  if (date) params.set('date', date);
  if (park) params.set('park', park);
  const data = await api('/games?' + params);

  const typeOpts = ['<option value="">Any</option>'].concat(
    Object.entries(META.gametypes).map(([k, v]) =>
      `<option value="${k}"${k === gametype ? ' selected' : ''}>${esc(v)}</option>`)).join('');
  const teamOpts = ['<option value="">Every club</option>'].concat(
    teams.map(t => `<option value="${t.id}"${t.id === team ? ' selected' : ''}>${
      esc((t.city || '') + ' ' + (t.nickname || ''))}</option>`)).join('');
  const years = [];
  for (let y = META.lastSeason; y >= META.firstSeason; y--) years.push(y);

  const rows = data.games.map(g => ({
    cells: [
      gameLink(g.id, niceDate(g.date) + (g.number !== '0' ? ` (${g.number})` : '')),
      teamLink(g.vis, g.season, g.visName),
      n(g.vis_score),
      teamLink(g.home, g.season, g.homeName),
      n(g.home_score),
      g.parkName ? link('#/park/' + g.park, g.parkName) : '',
      g.attendance ? g.attendance.toLocaleString() : '',
      (g.has_box ? '<span class="pill quiet">box</span>' : '')
      + (g.has_pbp ? '<span class="pill">plays</span>' : ''),
    ],
  }));

  app.innerHTML = `
    <div class="controls">
      <label>Season<select id="f-season">${years.map(y =>
        `<option${y == season ? ' selected' : ''}>${y}</option>`).join('')}</select></label>
      <label>Club<select id="f-team">${teamOpts}</select></label>
      <label>Type<select id="f-type">${typeOpts}</select></label>
      <label>Date<input type="date" id="f-date" value="${esc(date)}"></label>
    </div>
    <h2>${data.total.toLocaleString()} games${team ? '' : ` in ${season}`}</h2>
    <p class="note">${data.shown < data.total
      ? `Showing the first ${data.shown.toLocaleString()}.` : ''}</p>
    ${table([{ t: 'Date', l: 1 }, { t: 'Visitor', l: 1 }, { t: 'R' },
             { t: 'Home', l: 1 }, { t: 'R' }, { t: 'Park', l: 1 },
             { t: 'Attendance' }, { t: '', l: 1 }], rows,
            { empty: 'No games match those filters.' })}`;

  const go = () => {
    const p = new URLSearchParams({ season: val('f-season') });
    if (val('f-team')) p.set('team', val('f-team'));
    if (val('f-type')) p.set('gametype', val('f-type'));
    if (val('f-date')) p.set('date', val('f-date'));
    if (park) p.set('park', park);
    location.hash = '#/games?' + p;
  };
  ['f-season', 'f-team', 'f-type', 'f-date'].forEach(id =>
    document.getElementById(id).addEventListener('change', go));
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

function battingTable(rows, season) {
  const body = rows.map(b => ({
    cells: [
      playerLink(b.person, b.name)
      + (b.positions.length ? ` <span class="note">${esc(b.positions.join('-').toLowerCase())}</span>` : '')
      + (b.pinchHitInning ? ` <span class="pill quiet">PH ${b.pinchHitInning}</span>` : ''),
      n(b.ab), n(b.r), n(b.h), n(b.rbi), n(b.bb), n(b.so),
      n(b.d), n(b.t), n(b.hr), n(b.sb),
    ],
  }));
  const sum = k => rows.reduce((a, b) => a + (b[k] || 0), 0);
  if (rows.length) {
    body.push({
      _cls: 'totals',
      cells: ['Totals', sum('ab'), sum('r'), sum('h'), sum('rbi'), sum('bb'),
        sum('so'), sum('d'), sum('t'), sum('hr'), sum('sb')],
    });
  }
  return table([{ t: 'Batting', l: 1 }, { t: 'AB' }, { t: 'R' }, { t: 'H' }, { t: 'RBI' },
                { t: 'BB' }, { t: 'SO' }, { t: '2B' }, { t: '3B' }, { t: 'HR' }, { t: 'SB' }],
               body, { empty: 'No batting lines recorded.' });
}

function pitchingTable(rows) {
  const body = rows.map(p => ({
    cells: [playerLink(p.person, p.name), ip(p.outs), n(p.h), n(p.r), n(p.er),
      n(p.bb), n(p.so), n(p.hr), n(p.bfp)],
  }));
  return table([{ t: 'Pitching', l: 1 }, { t: 'IP' }, { t: 'H' }, { t: 'R' }, { t: 'ER' },
                { t: 'BB' }, { t: 'SO' }, { t: 'HR' }, { t: 'BF' }], body,
               { empty: 'No pitching lines recorded.' });
}

const EVENT_LABEL = { hr: 'HR', sb: 'SB', cs: 'CS', dp: 'DP', tp: 'TP', hp: 'HBP' };

function eventsHTML(events) {
  if (!events.length) return '';
  const by = {};
  events.forEach(e => (by[e.kind] = by[e.kind] || []).push(e));
  const items = Object.entries(by).map(([kind, list]) => {
    const text = list.map(e => {
      const who = e.playerNames.join(', ');
      if (kind === 'hr') return `${e.playerNames[0]} (${e.inning}${e.inning ? 'th' : ''} inn, off ${e.playerNames[1]})`;
      if (kind === 'sb' || kind === 'cs') return `${e.playerNames[0]}${e.inning ? ` (${e.inning})` : ''}`;
      return who;
    }).join('; ');
    return `<li><span class="k">${esc(EVENT_LABEL[kind] || kind)}</span> ${esc(text)}</li>`;
  }).join('');
  return `<h3>In the box</h3><ul class="events">${items}</ul>`;
}

async function viewGame(parts) {
  const d = await api('/game/' + parts[0]);
  const g = d.game, p = d.people;
  const meta = [];
  const add = (k, v) => { if (v) meta.push(`<div><span class="k">${k}</span> ${v}</div>`); };
  add('Park', d.park ? link('#/park/' + d.park.id, d.park.name) : g.park);
  add('Attendance', g.attendance ? g.attendance.toLocaleString() : '');
  add('Time', g.duration ? `${Math.floor(g.duration / 60)}:${String(g.duration % 60).padStart(2, '0')}` : '');
  add('Started', g.start_time);
  add('Winning pitcher', playerLink(g.wp, p.wp));
  add('Losing pitcher', playerLink(g.lp, p.lp));
  add('Save', playerLink(g.sv, p.sv));
  add('Home plate', playerLink(g.ump_hp, p.ump_hp));
  add('Managers', [p.mgr_vis, p.mgr_home].filter(Boolean).join(' / '));
  add('Weather', [g.temp ? g.temp + '°F' : '', g.sky !== 'unknown' ? g.sky : '',
    g.wind_speed ? `wind ${g.wind_speed}mph` : ''].filter(Boolean).join(', '));

  const sides = [0, 1].map(side => ({
    side,
    name: side === 0 ? g.visName : g.homeName,
    bat: d.batting.filter(b => b.side === side),
    pit: d.pitching.filter(x => x.side === side),
  }));

  app.innerHTML = `
    <div class="crumb">${link('#/games?season=' + g.season, g.season + ' games')}
      · ${link('#/day/' + g.date, 'every game that day')}</div>
    <div class="gamehead">
      <div class="score">
        <span class="${g.vis_score > g.home_score ? 'win' : ''}">${esc(g.visName)} ${n(g.vis_score)}</span>
        &nbsp;at&nbsp;
        <span class="${g.home_score > g.vis_score ? 'win' : ''}">${esc(g.homeName)} ${n(g.home_score)}</span>
      </div>
      <div>${esc(g.gametypeLabel)}${g.has_pbp ? '<span class="pill">play-by-play</span>' : ''}</div>
    </div>
    <p class="note">${niceDate(g.date)}${g.number !== '0' ? ` — game ${g.number} of a doubleheader` : ''}</p>
    ${lineScoreHTML(g)}
    <div class="meta-grid">${meta.join('')}</div>
    ${sides.map(s => `<h3>${esc(s.name)}</h3>${battingTable(s.bat)}${pitchingTable(s.pit)}`).join('')}
    ${eventsHTML(d.events)}`;
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

  const fldRows = d.fielding.map(r => ({
    cells: [r.season, r.position, r.g, ip(r.outs), n(r.po), n(r.a), n(r.e), n(r.dp)],
  }));

  const pitcherFirst = psum('outs') > 0 && bsum('ab') < 500;
  const batting = batRows.length ? `<h3>Batting</h3>${table(
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

async function renderGameLog(id, season) {
  const d = await api(`/player/${id}/games?season=${season}`);
  const rows = d.games.map(g => ({
    cells: [
      gameLink(g.id, niceDate(g.date)),
      teamLink(g.team, g.season, g.teamName),
      (g.side === 0 ? 'at ' : 'vs ') + esc(g.oppName),
      `${n(g.vis_score)}–${n(g.home_score)}`,
      n(g.ab), n(g.r), n(g.h), n(g.hr), n(g.rbi), n(g.bb), n(g.so),
      g.ip ?? '', n(g.p_h), n(g.p_er), n(g.p_so),
    ],
  }));
  document.getElementById('gamelog').innerHTML =
    `<p class="note">${d.total} games in ${season}.</p>` + table(
      [{ t: 'Date', l: 1 }, { t: 'Team', l: 1 }, { t: 'Opponent', l: 1 }, { t: 'Score' },
       { t: 'AB' }, { t: 'R' }, { t: 'H' }, { t: 'HR' }, { t: 'RBI' }, { t: 'BB' },
       { t: 'SO' }, { t: 'IP' }, { t: 'H' }, { t: 'ER' }, { t: 'SO' }], rows,
      { empty: 'No games that season.' });
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
  const byLeague = {};
  d.teams.forEach(t => (byLeague[t.league || 'Other'] = byLeague[t.league || 'Other'] || []).push(t));
  const blocks = Object.entries(byLeague).map(([lg, ts]) => `<h3>${esc(lg)}</h3>` + table(
    [{ t: 'Club', l: 1 }, { t: 'Games' }],
    ts.map(t => ({ cells: [teamLink(t.id, season, `${t.city} ${t.nickname}`), t.n] })))).join('');
  app.innerHTML = `
    <div class="controls"><label>Season<select id="t-season">${years.map(y =>
      `<option${y == season ? ' selected' : ''}>${y}</option>`).join('')}</select></label></div>
    <h2>Clubs in ${season}</h2>${blocks}`;
  document.getElementById('t-season').addEventListener('change', e => {
    location.hash = '#/teams?season=' + e.target.value;
  });
}

// ---------------------------------------------------------------- day, park

async function viewDay(parts) {
  const d = await api('/day/' + parts[0]);
  const rows = d.games.map(g => ({
    cells: [gameLink(g.id, `${g.visName} at ${g.homeName}`),
      `${n(g.vis_score)}–${n(g.home_score)}`,
      g.parkName ? link('#/park/' + g.park, g.parkName) : '',
      g.attendance ? g.attendance.toLocaleString() : '',
      esc(META.gametypes[g.gametype] || '')],
  }));
  app.innerHTML = `<h2>${niceDate(d.date)}</h2>` + table(
    [{ t: 'Game', l: 1 }, { t: 'Score' }, { t: 'Park', l: 1 }, { t: 'Att' },
     { t: 'Type', l: 1 }], rows, { empty: 'No games that day.' });
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

async function viewSearch(_, q) {
  const term = q.get('q') || '';
  app.innerHTML = `
    <div class="controls">
      <label>Name<input type="search" id="s-q" value="${esc(term)}"
             placeholder="Ruth, Mays, Aparicio…" autofocus></label>
      <button id="s-go">Search</button>
    </div>
    <div id="results"></div>`;
  const go = () => { location.hash = '#/search?q=' + encodeURIComponent(val('s-q')); };
  document.getElementById('s-go').addEventListener('click', go);
  document.getElementById('s-q').addEventListener('keydown', e => {
    if (e.key === 'Enter') go();
  });
  if (!term) return;
  const d = await api('/search?q=' + encodeURIComponent(term));
  const rows = d.results.map(r => ({
    cells: [playerLink(r.id, r.name) + (r.hof ? '<span class="pill alt">HOF</span>' : ''),
      esc(r.roles.join(', ')),
      r.debut ? r.debut.slice(0, 4) : '',
      r.lastGame ? r.lastGame.slice(0, 4) : '',
      r.games ? r.games.toLocaleString() : ''],
  }));
  document.getElementById('results').innerHTML = table(
    [{ t: 'Name', l: 1 }, { t: 'Known as', l: 1 }, { t: 'From' }, { t: 'To' },
     { t: 'Games' }], rows, { empty: 'Nobody by that name.' });
}

// -------------------------------------------------------------------- about

async function viewAbout() {
  app.innerHTML = `
    <h2>About</h2>
    <p class="note">Built from the Retrosheet data files. ${META.games.toLocaleString()}
      games, ${META.firstSeason}–${META.lastSeason};
      ${META.withBox.toLocaleString()} of them with a full box score and
      ${META.withPlays.toLocaleString()} with play-by-play.</p>

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
