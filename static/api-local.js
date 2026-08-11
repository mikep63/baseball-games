/* In-browser reimplementation of app.py's API, over the columnar exports in
   data/. Returns the same JSON shapes app.py does, so app.js cannot tell the
   difference and there is one frontend rather than two.

   Only loaded by the docs/ build. When app.py is serving, window.LocalAPI is
   absent and app.js falls through to fetch('/api...'). */
'use strict';

window.LocalAPI = (function () {

  // ---------------------------------------------------------------- loading

  const cache = new Map();
  function load(path) {
    if (!cache.has(path)) {
      cache.set(path, fetch('data/' + path).then(r => {
        if (!r.ok) throw new Error('missing ' + path);
        return r.json();
      }));
    }
    return cache.get(path);
  }

  /* Columnar -> objects. The exports store one list of column names and then
     rows as bare arrays; every reader below wants objects. */
  function rows(payload, colKey, rowKey) {
    const c = payload[colKey], r = payload[rowKey] || [];
    return r.map(row => {
      const o = {};
      for (let i = 0; i < c.length; i++) o[c[i]] = row[i];
      return o;
    });
  }

  const seasonOf = gid => Number(gid.slice(3, 7));
  const season = y => load('season/' + y + '.json');

  // indexes built once, on first use
  let _people = null, _teams = null, _parks = null, _bio = null;

  async function people() {
    if (!_people) {
      const p = await load('people.json');
      const list = rows(p, 'c', 'r');
      // Lower-cased once here rather than 27,000 times per keystroke: the
      // search runs on every character typed, and rebuilding these strings
      // each time is what makes a live search feel sticky.
      for (const x of list) {
        x._full = ((x.first || '') + ' ' + (x.last || '')).trim().toLowerCase();
        x._nick = ((x.nickname || '') + ' ' + (x.last || '')).trim().toLowerCase();
        x._last = (x.last || '').toLowerCase();
      }
      const by = new Map(list.map(x => [x.id, x]));
      _people = { list, by };
    }
    return _people;
  }
  async function teams() {
    if (!_teams) {
      const t = await load('teams.json');
      const list = rows(t, 'c', 'r');
      const by = new Map(list.map(x => [x.id + '|' + x.season, x]));
      _teams = { list, by, played: rows(t, 'playedC', 'played') };
    }
    return _teams;
  }
  async function parks() {
    if (!_parks) {
      const p = await load('parks.json');
      const list = rows(p, 'c', 'r');
      _parks = { list, by: new Map(list.map(x => [x.id, x])),
                 season: rows(p, 'seasonC', 'season') };
    }
    return _parks;
  }
  /* Careers are sharded on the player id's first character, so a player page
     fetches under a megabyte rather than the whole 18 MB of every career. */
  const _careerShards = new Map();
  async function careers(pid) {
    const letter = pid[0];
    if (!_careerShards.has(letter)) {
      _careerShards.set(letter, load('careers/' + letter + '.json').then(c => ({
        bat: rows(c, 'batC', 'bat'), pit: rows(c, 'pitC', 'pit'),
        fld: rows(c, 'fldC', 'fld'),
      })));
    }
    return _careerShards.get(letter);
  }
  /* Managing and umpiring, one small file for everyone rather than a shard
     per initial: 15,000 rows against the careers' 140,000. */
  let _roles = null;
  async function roles() {
    if (!_roles) {
      const r = await load('roles.json');
      _roles = { mgr: rows(r, 'mgrC', 'mgr'), ump: rows(r, 'umpC', 'ump') };
    }
    return _roles;
  }
  async function bio() {
    if (!_bio) {
      const b = await load('bio.json');
      _bio = new Map(rows(b, 'c', 'r').map(x => [x.id, x]));
    }
    return _bio;
  }

  // ------------------------------------------------------------- shared bits

  const POSITIONS = { 1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS',
    7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH', 11: 'PH', 12: 'PR' };

  const nameOf = p => p ? ((p.nickname || p.first || '') + ' ' + (p.last || '')).trim() : null;

  async function teamName(code, yr) {
    const t = await teams();
    const r = t.by.get(code + '|' + yr);
    return r ? ((r.city || '') + ' ' + (r.nickname || '')).trim() : code;
  }

  /* One season's shard, turned into the object lists the endpoints want.
     Game ids were replaced by their index on export; put them back. */
  const shards = new Map();
  async function shard(yr) {
    if (!shards.has(yr)) {
      shards.set(yr, (async () => {
        const s = await season(yr);
        const games = rows(s, 'gameC', 'games');
        games.forEach(g => { g.season = yr; });
        const deref = (list, key) => list.forEach(x => { x.game = games[x[key]].id; });
        const bat = rows(s, 'batC', 'bat'); deref(bat, 'g');
        const pit = rows(s, 'pitC', 'pit'); deref(pit, 'g');
        const ph = rows(s, 'phC', 'ph'); deref(ph, 'g');
        const pr = rows(s, 'prC', 'pr'); deref(pr, 'g');
        // sparse extras: absent means zero, not unknown
        const batx = rows(s, 'batxC', 'batx'); deref(batx, 'g');
        const xBy = new Map(batx.map(x => [x.game + '|' + x.person, x]));
        bat.forEach(b => {
          const x = xBy.get(b.game + '|' + b.person);
          for (const k of ['sh', 'sf', 'hbp', 'cs', 'gidp']) b[k] = x ? (x[k] || 0) : 0;
        });
        const bev = rows(s, 'bevC', 'bev'); deref(bev, 'g');
        const tbox = rows(s, 'tboxC', 'tbox'); deref(tbox, 'g');
        const ros = rows(s, 'rosC', 'ros');
        const byId = new Map(games.map(g => [g.id, g]));
        const group = (list) => {
          const m = new Map();
          list.forEach(x => { if (!m.has(x.game)) m.set(x.game, []); m.get(x.game).push(x); });
          return m;
        };
        return { games, byId, bat: group(bat), pit: group(pit),
                 ph: group(ph), pr: group(pr), bev: group(bev),
                 tbox: group(tbox), ros,
                 allBat: bat, allPit: pit };
      })());
    }
    return shards.get(yr);
  }

  async function decorate(games) {
    const pk = await parks();
    for (const g of games) {
      g.visName = await teamName(g.vis, g.season);
      g.homeName = await teamName(g.home, g.season);
      const p = pk.by.get(g.park);
      g.parkName = p ? p.name : null;
    }
    return games;
  }

  // ------------------------------------------------------------- endpoints

  async function meta() { return load('meta.json'); }

  async function search(q) {
    const term = (q.get('q') || '').trim().toLowerCase();
    if (term.length < 2) return { results: [] };
    const { list } = await people();
    const out = [];
    for (const p of list) {
      const full = p._full, nick = p._nick, last = p._last;
      if (!full.includes(term) && !nick.includes(term) && !last.includes(term)) continue;
      const exact = full === term ? 0 : last === term ? 1
        : last.startsWith(term) ? 2 : full.startsWith(term) ? 3 : 4;
      out.push({ p, exact });
    }
    out.sort((a, b) => a.exact - b.exact || (b.p.games || 0) - (a.p.games || 0));
    return { results: out.slice(0, 60).map(({ p }) => ({
      id: p.id, name: nameOf(p), hof: p.hof, debut: p.debut, lastGame: p.lastGame,
      games: p.games || 0,
      roles: [['player', p.debut], ['manager', p.mgrDebut], ['umpire', p.umpDebut]]
        .filter(([, v]) => v).map(([k]) => k),
    })) };
  }

  /* app.py's _day_counts, over the shard. The list handed in must be the one
     every filter *except* `date` has narrowed: the calendar is what the reader
     picks a day with, and a calendar narrowed by his own pick is one cell.

     The shard is exported ORDER BY date, number, id, which is the order app.py
     reads the games back in, so the W/L string comes out the same both sides. */
  function dayCounts(list, team) {
    const out = [];
    for (const g of list) {
      let res = '';
      if (team) {
        const home = g.home === team;
        const us = home ? g.home_score : g.vis_score;
        const them = home ? g.vis_score : g.home_score;
        res = (us == null || them == null) ? '?'
          : us > them ? 'W' : us < them ? 'L' : 'T';
      }
      const last = out[out.length - 1];
      if (!last || last[0] !== g.date) { out.push(team ? [g.date, 1, res] : [g.date, 1]); continue; }
      last[1]++;
      // Guarded: with no club there is no third element, and `undefined + ''`
      // would quietly put the string "undefined" there instead.
      if (team) last[2] += res;
    }
    return out;
  }

  async function gamesList(q) {
    const yr = Number(q.get('season')) || (await meta()).lastSeason;
    const s = await shard(yr);
    const team = q.get('team'), type = q.get('gametype');
    const date = q.get('date'), park = q.get('park');
    const from = q.get('from'), to = q.get('to');
    let list = s.games.filter(g =>
      (!team || g.vis === team || g.home === team) &&
      (!type || g.gametype === type) &&
      (!park || g.park === park) &&
      (!from || g.date >= from) && (!to || g.date <= to));
    const days = dayCounts(list, team);
    if (date) list = list.filter(g => g.date === date);
    const total = list.length;
    // Number('0') is falsy, so `|| 200` would quietly turn the calendar-only
    // request into a request for 200 games nobody is going to look at.
    const asked = Number(q.get('limit'));
    const limit = Math.min(Number.isFinite(asked) && asked >= 0 ? asked : 200, 1000);
    list = list.slice(0, limit).map(g => Object.assign({}, g));
    return { games: await decorate(list), total, shown: list.length, days };
  }

  async function teamsList(q) {
    const yr = Number(q.get('season'));
    const t = await teams();
    if (!yr) return { franchises: [] };
    const played = new Map(t.played.filter(p => p.season === yr).map(p => [p.team, p]));
    const out = t.list.filter(x => x.season === yr && played.has(x.id))
      .map(x => ({ id: x.id, league: x.league, city: x.city, nickname: x.nickname,
                   n: played.get(x.id).games, allstar: played.get(x.id).allstar }))
      // SQLite sorts NULL before any value in an ascending ORDER BY, and the
      // clubs with no league recorded are the Negro League and exhibition
      // sides, so they head the list rather than trailing it.
      .sort((a, b) => a.allstar - b.allstar
                   || (b.league == null) - (a.league == null)
                   || String(a.league || '').localeCompare(String(b.league || ''))
                   || String(a.city || '').localeCompare(String(b.city || '')));
    return { teams: out };
  }

  async function game(gid) {
    const yr = seasonOf(gid);
    const s = await shard(yr);
    const g = s.byId.get(gid);
    if (!g) throw new Error('no such game');
    const pe = (await people()).by, pk = await parks();
    const M = await meta();

    const phBy = new Map((s.ph.get(gid) || []).map(x => [x.person, x.inning]));
    const prBy = new Map((s.pr.get(gid) || []).map(x => [x.person, x.inning]));

    const last = id => (pe.get(id) || {}).last || null;
    const batting = (s.bat.get(gid) || []).map(b => Object.assign({}, b, {
      name: nameOf(pe.get(b.person)), lastName: last(b.person),
      positions: b.pos ? String(b.pos).split('-').map(x => POSITIONS[x] || x) : [],
      pinchHitInning: phBy.get(b.person) ?? null,
      pinchRunInning: prBy.get(b.person) ?? null,
    }));
    const pitching = (s.pit.get(gid) || []).map(p => Object.assign({}, p, {
      name: nameOf(pe.get(p.person)), lastName: last(p.person),
    }));
    const events = (s.bev.get(gid) || []).map(e => {
      const parts = (e.players || '').split(',').filter(Boolean);
      return Object.assign({}, e, {
        // The export calls it `on` to keep the shards short; app.py calls it
        // runners_on and app.py is the shape both backends answer in.
        runners_on: e.on ?? null,
        playerNames: parts.map(x => nameOf(pe.get(x)) || x),
        playerLast: parts.map(x => last(x) || nameOf(pe.get(x)) || x),
      });
    });

    const who = {};
    ['wp', 'lp', 'sv', 'ump_hp', 'ump_1b', 'ump_2b', 'ump_3b', 'ump_lf', 'ump_rf',
     'mgr_vis', 'mgr_home', 'vis_sp', 'home_sp'].forEach(k => {
      who[k] = g[k] ? nameOf(pe.get(g[k])) : null;
    });

    return {
      game: Object.assign({}, g, {
        visName: await teamName(g.vis, yr),
        homeName: await teamName(g.home, yr),
        gametypeLabel: M.gametypes[g.gametype] || g.gametype,
        visLine: g.vis_line ? g.vis_line.split(',') : [],
        homeLine: g.home_line ? g.home_line.split(',') : [],
      }),
      park: pk.by.get(g.park) || null,
      people: who, batting, pitching, fielding: [], running: [],
      teamBox: Object.fromEntries((s.tbox.get(gid) || []).map(t => [t.side, t])),
      events,
    };
  }

  async function player(pid) {
    const pe = (await people()).by, bios = await bio(), c = await careers(pid);
    const base = pe.get(pid);
    if (!base) throw new Error('no such person');
    const b = bios.get(pid) || {};
    const person = {
      id: pid, name: nameOf(base), hof: base.hof,
      play_debut: base.debut, play_last: base.lastGame,
      bats: b.bats, throws: b.throws, height: b.height, weight: b.weight,
      birthdate: b.birthdate, birth_city: b.birthCity, birth_state: b.birthState,
      birth_country: b.birthCountry, deathdate: b.deathdate,
      mgr_debut: b.mgrDebut, mgr_last: b.mgrLast,
      coach_debut: b.coachDebut, coach_last: b.coachLast,
      ump_debut: b.umpDebut, ump_last: b.umpLast,
    };
    const batting = c.bat.filter(r => r.person === pid).map(r => Object.assign({}, r));
    const pitching = c.pit.filter(r => r.person === pid).map(r => Object.assign({}, r));
    const fielding = c.fld.filter(r => r.person === pid).map(r =>
      Object.assign({}, r, { position: POSITIONS[r.pos] || String(r.pos) }));
    const ro = await roles();
    const managing = ro.mgr.filter(r => r.person === pid).map(r => Object.assign({}, r));
    const umpiring = ro.ump.filter(r => r.person === pid).map(r => Object.assign({}, r));
    for (const r of batting.concat(pitching, managing)) {
      r.teamName = await teamName(r.team, r.season);
    }
    const seasons = [...new Set(batting.concat(pitching, managing, umpiring)
      .map(r => r.season))].sort();
    return { person, batting, pitching, fielding, managing, umpiring, seasons };
  }

  async function playerGames(pid, q) {
    const yr = Number(q.get('season'));
    if (!yr) return { games: [], total: 0 };
    const s = await shard(yr);
    const byGame = new Map();
    for (const b of s.allBat) if (b.person === pid) byGame.set(b.game, { bat: b });
    for (const p of s.allPit) if (p.person === pid) {
      const e = byGame.get(p.game) || {}; e.pit = p; byGame.set(p.game, e);
    }
    const out = [];
    for (const [gid, e] of byGame) {
      const g = s.byId.get(gid);
      const side = (e.bat || e.pit).side;
      const team = side === 0 ? g.vis : g.home, opp = side === 0 ? g.home : g.vis;
      out.push({
        id: g.id, date: g.date, season: yr, gametype: g.gametype,
        vis: g.vis, home: g.home, vis_score: g.vis_score, home_score: g.home_score,
        park: g.park, side, team, opp,
        teamName: await teamName(team, yr), oppName: await teamName(opp, yr),
        ab: e.bat?.ab ?? null, r: e.bat?.r ?? null, h: e.bat?.h ?? null,
        d: e.bat?.d ?? null, t: e.bat?.t ?? null, hr: e.bat?.hr ?? null,
        rbi: e.bat?.rbi ?? null, bb: e.bat?.bb ?? null, so: e.bat?.so ?? null,
        sb: e.bat?.sb ?? null,
        hbp: e.bat?.hbp ?? null, sh: e.bat?.sh ?? null, sf: e.bat?.sf ?? null,
        p_h: e.pit?.h ?? null, p_r: e.pit?.r ?? null, p_er: e.pit?.er ?? null,
        p_bb: e.pit?.bb ?? null, p_so: e.pit?.so ?? null, p_hr: e.pit?.hr ?? null,
        p_outs: e.pit?.outs ?? null,
        ip: e.pit && e.pit.outs != null
          ? Math.floor(e.pit.outs / 3) + '.' + (e.pit.outs % 3) : null,
      });
    }
    out.sort((a, b) => a.date.localeCompare(b.date));

    // The same season from the bench and from behind the plate, kept apart
    // from the playing log the way app.py keeps them.
    const UMP = [['ump_hp', 'HP'], ['ump_1b', '1B'], ['ump_2b', '2B'],
                 ['ump_3b', '3B'], ['ump_lf', 'LF'], ['ump_rf', 'RF']];
    const managed = [], umpired = [];
    for (const g of s.games) {
      const home = g.mgr_home === pid;
      if (home || g.mgr_vis === pid) {
        const team = home ? g.home : g.vis, opp = home ? g.vis : g.home;
        const us = home ? g.home_score : g.vis_score;
        const them = home ? g.vis_score : g.home_score;
        managed.push({
          id: g.id, date: g.date, season: yr, gametype: g.gametype,
          vis: g.vis, home: g.home, vis_score: g.vis_score,
          home_score: g.home_score, park: g.park, team, opp, side: home ? 1 : 0,
          result: (us == null || them == null) ? null
            : us > them ? 'W' : us < them ? 'L' : 'T',
          teamName: await teamName(team, yr), oppName: await teamName(opp, yr),
          visName: await teamName(g.vis, yr), homeName: await teamName(g.home, yr),
        });
      }
      const at = UMP.find(([k]) => g[k] === pid);
      if (at) {
        umpired.push({
          id: g.id, date: g.date, season: yr, gametype: g.gametype,
          vis: g.vis, home: g.home, vis_score: g.vis_score,
          home_score: g.home_score, park: g.park, position: at[1],
          visName: await teamName(g.vis, yr), homeName: await teamName(g.home, yr),
        });
      }
    }
    const byDate = (a, b) => a.date.localeCompare(b.date);
    managed.sort(byDate); umpired.sort(byDate);

    // The log stands as its own page, so it carries the name and the other
    // seasons with it rather than sending the reader back for them.
    const base = (await people()).by.get(pid);
    const c = await careers(pid), ro = await roles();
    const seasons = [...new Set([
      ...c.bat.filter(r => r.person === pid).map(r => r.season),
      ...c.pit.filter(r => r.person === pid).map(r => r.season),
      ...ro.mgr.filter(r => r.person === pid).map(r => r.season),
      ...ro.ump.filter(r => r.person === pid).map(r => r.season),
    ])].sort();

    return { person: base ? { id: pid, name: nameOf(base) } : null, seasons,
             games: out, managed, umpired,
             total: out.length + managed.length + umpired.length };
  }

  async function team(code, q) {
    const yr = Number(q.get('season'));
    const t = await teams();
    if (!yr) {
      return { team: code,
        seasons: t.played.filter(p => p.team === code)
          .map(p => ({ season: p.season, n: p.games }))
          .sort((a, b) => a.season - b.season) };
    }
    const s = await shard(yr);
    const M = await meta();
    const games = s.games.filter(g => g.vis === code || g.home === code);
    const tally = {};
    const out = [];
    for (const g of games) {
      const home = g.home === code;
      const us = home ? g.home_score : g.vis_score;
      const them = home ? g.vis_score : g.home_score;
      const opp = home ? g.vis : g.home;
      const rec = tally[g.gametype] || (tally[g.gametype] = { w: 0, l: 0, t: 0 });
      let result = null;
      if (us == null || them == null) result = null;
      else if (us > them) { rec.w++; result = 'W'; }
      else if (us < them) { rec.l++; result = 'L'; }
      else { rec.t++; result = 'T'; }
      out.push(Object.assign({}, g, {
        us, them, opp, atHome: home, result,
        oppName: await teamName(opp, yr),
        record: g.gametype === 'regular'
          ? `${rec.w}-${rec.l}${rec.t ? '-' + rec.t : ''}` : null,
      }));
    }
    const pe = (await people()).by;
    const roster = s.ros.filter(r => r.team === code).map(r => ({
      person: r.person, pos: r.pos, bats: r.bats, throws: r.throws,
      name: nameOf(pe.get(r.person)) || r.person,
    })).sort((a, b) => {
      const pa = pe.get(a.person) || {}, pb = pe.get(b.person) || {};
      return String(pa.last || '').localeCompare(String(pb.last || ''))
          || String(pa.first || '').localeCompare(String(pb.first || ''));
    });
    const records = {};
    for (const [k, v] of Object.entries(tally)) {
      records[k] = Object.assign({}, v, { label: M.gametypes[k] || k });
    }
    return { team: code, season: yr, info: t.by.get(code + '|' + yr) || null,
             games: out, record: tally.regular || { w: 0, l: 0, t: 0 },
             records, roster };
  }

  async function park(id) {
    const pk = await parks();
    const p = pk.by.get(id);
    if (!p) throw new Error('no such park');
    const rowsFor = pk.season.filter(x => x.park === id);
    const n = rowsFor.reduce((a, x) => a + x.games, 0);
    return { park: p,
      span: { a: rowsFor.length ? rowsFor[0].season : null,
              b: rowsFor.length ? rowsFor[rowsFor.length - 1].season : null,
              n, att: null },
      bySeason: rowsFor.map(x => ({ season: x.season, n: x.games, avg_att: x.avgAtt })) };
  }

  // ----------------------------------------------------------------- router

  async function get(path) {
    const [p, qs] = path.split('?');
    const q = new URLSearchParams(qs || '');
    let m;
    if (p === '/meta') return meta();
    if (p === '/search') return search(q);
    if (p === '/games') return gamesList(q);
    if (p === '/teams') return teamsList(q);
    if ((m = p.match(/^\/game\/([A-Z0-9]+)$/))) return game(m[1]);
    if ((m = p.match(/^\/player\/([a-z0-9]+)\/games$/))) return playerGames(m[1], q);
    if ((m = p.match(/^\/player\/([a-z0-9]+)$/))) return player(m[1]);
    if ((m = p.match(/^\/team\/([A-Z0-9]+)$/))) return team(m[1], q);
    if ((m = p.match(/^\/park\/([A-Z0-9]+)$/))) return park(m[1]);
    throw new Error('unknown endpoint: ' + p);
  }

  return { get };
})();
