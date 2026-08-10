#!/usr/bin/env python3
"""Baseball Games -- a local web app over the Retrosheet game and box-score data.

Standard library only; no pip installs.

Usage:
  python3 app.py            # serves http://127.0.0.1:8000
  python3 app.py --lan      # also reachable from other devices on the network
  python3 app.py --port N

This module is the reference implementation. The iOS front end ports these
queries into Swift and is expected to return the same answers, so a change to
a query here is only half a change.
"""
import argparse
import json
import os
import re
import socket
import sqlite3
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE, "retro.sqlite")
STATIC = os.path.join(BASE, "static")

POSITIONS = {1: "P", 2: "C", 3: "1B", 4: "2B", 5: "3B", 6: "SS", 7: "LF",
             8: "CF", 9: "RF", 10: "DH", 11: "PH", 12: "PR"}

# The order a season's rounds are played in, so the filter reads down the
# calendar rather than in whatever order the rows came back.
GAMETYPE_ORDER = ["regular", "wildcard", "division", "lcs", "worldseries",
                  "allstar", "negro"]

GAMETYPES = {"regular": "Regular season", "worldseries": "World Series",
             "lcs": "League Championship Series", "division": "Division Series",
             "wildcard": "Wild Card", "allstar": "All-Star Game",
             "negro": "Negro Leagues"}


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def rows(cur):
    return [dict(r) for r in cur.fetchall()]


def one(cur):
    r = cur.fetchone()
    return dict(r) if r else None


def arg(q, key, default=None):
    v = q.get(key, [default])[0]
    return v if v not in ("", None) else default


def intarg(q, key, default=None):
    try:
        return int(arg(q, key))
    except (TypeError, ValueError):
        return default


# ------------------------------------------------------------------- naming

def name_of(p):
    """Display name, preferring the name he was known by."""
    if not p:
        return None
    first = p.get("nickname") or p.get("first") or ""
    return ("%s %s" % (first, p.get("last") or "")).strip()


def people_map(conn, ids):
    """id -> display name, for a batch of ids. One query, not one per row."""
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    out = {}
    for chunk in (ids[i:i + 400] for i in range(0, len(ids), 400)):
        cur = conn.execute("SELECT id, first, last, nickname FROM person WHERE id IN (%s)"
                           % ",".join("?" * len(chunk)), chunk)
        for r in cur:
            out[r["id"]] = name_of(dict(r))
    return out


def surname_map(conn, ids):
    """id -> surname. Box-score summaries are written in last names."""
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    out = {}
    for chunk in (ids[i:i + 400] for i in range(0, len(ids), 400)):
        for r in conn.execute("SELECT id, last FROM person WHERE id IN (%s)"
                              % ",".join("?" * len(chunk)), chunk):
            out[r["id"]] = r["last"]
    return out


def team_map(conn, pairs):
    """(team, season) -> "City Nickname"."""
    out = {}
    for team, season in set(p for p in pairs if p[0]):
        r = conn.execute("SELECT city, nickname FROM team WHERE id=? AND season=?",
                         (team, season)).fetchone()
        if r:
            out[(team, season)] = ("%s %s" % (r["city"] or "", r["nickname"] or "")).strip()
        else:
            out[(team, season)] = team
    return out


# ------------------------------------------------------------------- handlers

def api_meta(q, conn):
    m = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM meta")}
    counts = one(conn.execute(
        "SELECT COUNT(*) games, SUM(has_box) with_box, SUM(has_pbp) with_pbp FROM game"))
    # Which kinds of game each season actually had. There were no division
    # series in 1968, no All-Star game in 2020 and no World Series in 1994,
    # and a filter that offers them is offering nothing. 7 KB for all 155.
    by_season = {}
    for season, gametype in conn.execute(
            "SELECT DISTINCT season, gametype FROM game ORDER BY season"):
        by_season.setdefault(season, []).append(gametype)
    for v in by_season.values():
        v.sort(key=lambda g: GAMETYPE_ORDER.index(g) if g in GAMETYPE_ORDER else 99)
    return {"firstSeason": int(m["first_season"]), "lastSeason": int(m["last_season"]),
            "games": counts["games"], "withBox": counts["with_box"],
            "withPlays": counts["with_pbp"], "gametypes": GAMETYPES,
            "seasonTypes": by_season}


def api_search(q, conn):
    """People search, ranked by how well the name matches then by career length."""
    term = (arg(q, "q") or "").strip()
    if len(term) < 2:
        return {"results": []}
    like = "%" + term.lower().replace(" ", "%") + "%"
    cur = conn.execute("""
        SELECT p.id, p.first, p.last, p.nickname, p.play_debut, p.play_last,
               p.mgr_debut, p.ump_debut, p.hof,
               (SELECT COUNT(*) FROM bat b WHERE b.person = p.id) AS batg,
               (SELECT COUNT(*) FROM pit t WHERE t.person = p.id) AS pitg
        FROM person p
        WHERE LOWER(COALESCE(p.first,'') || ' ' || COALESCE(p.last,'')) LIKE ?
           OR LOWER(COALESCE(p.nickname,'') || ' ' || COALESCE(p.last,'')) LIKE ?
           OR LOWER(COALESCE(p.last,'')) LIKE ?
        LIMIT 400""", (like, like, like))
    out = []
    lt = term.lower()
    for r in rows(cur):
        full = ("%s %s" % (r["first"] or "", r["last"] or "")).strip().lower()
        last = (r["last"] or "").lower()
        exact = 0 if full == lt else (1 if last == lt else
                                      (2 if last.startswith(lt) else
                                       (3 if full.startswith(lt) else 4)))
        out.append({
            "id": r["id"], "name": name_of(r), "hof": r["hof"],
            "debut": r["play_debut"], "lastGame": r["play_last"],
            "games": (r["batg"] or 0) + (r["pitg"] or 0),
            "roles": [k for k, v in (("player", r["play_debut"]),
                                     ("manager", r["mgr_debut"]),
                                     ("umpire", r["ump_debut"])) if v],
            "_rank": (exact, -(r["batg"] or 0) - (r["pitg"] or 0)),
        })
    out.sort(key=lambda x: x["_rank"])
    for o in out:
        del o["_rank"]
    return {"results": out[:60]}


GAME_LIST_SQL = """
    SELECT g.id, g.date, g.number, g.season, g.gametype, g.vis, g.home,
           g.vis_score, g.home_score, g.park, g.attendance, g.duration,
           g.has_box, g.has_pbp, g.daynight
    FROM game g WHERE 1=1 """


def _decorate_games(conn, gs):
    names = team_map(conn, [(g["vis"], g["season"]) for g in gs]
                     + [(g["home"], g["season"]) for g in gs])
    parks = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM park")}
    for g in gs:
        g["visName"] = names.get((g["vis"], g["season"]), g["vis"])
        g["homeName"] = names.get((g["home"], g["season"]), g["home"])
        g["parkName"] = parks.get(g["park"])
    return gs


def _day_counts(conn, where, params, team):
    """The calendar: the same filter, grouped by date.

    Note what is *not* in `where` -- the caller withholds the `date` clause.
    The calendar is the control the reader picks a day with, so narrowing it
    by the day he picked would collapse it to the single cell he just
    clicked, leaving him no way back.

    With a club chosen the count is always one, or two on a doubleheader, so
    a bare number tells him nothing he cannot already see. The day carries
    W/L/T instead, in the order the games were played.
    """
    clause = "".join(" AND " + w for w in where)
    if not team:
        return [[r["date"], r["n"]] for r in conn.execute(
            "SELECT g.date date, COUNT(*) n FROM game g WHERE 1=1" + clause
            + " GROUP BY g.date ORDER BY g.date", params)]
    out = []
    for r in conn.execute(
            "SELECT g.date, g.home, g.vis_score, g.home_score FROM game g"
            " WHERE 1=1" + clause + " ORDER BY g.date, g.number, g.id", params):
        us, them = ((r["home_score"], r["vis_score"]) if r["home"] == team
                    else (r["vis_score"], r["home_score"]))
        if us is None or them is None:
            res = "?"
        else:
            res = "W" if us > them else "L" if us < them else "T"
        if out and out[-1][0] == r["date"]:
            out[-1][1] += 1
            out[-1][2] += res
        else:
            out.append([r["date"], 1, res])
    return out


def api_games(q, conn):
    """The game finder: any combination of season, team, park, date, type."""
    where, params = [], []
    if arg(q, "season"):
        where.append("g.season = ?"); params.append(intarg(q, "season"))
    if arg(q, "from"):
        where.append("g.date >= ?"); params.append(arg(q, "from"))
    if arg(q, "to"):
        where.append("g.date <= ?"); params.append(arg(q, "to"))
    if arg(q, "team"):
        where.append("(g.vis = ? OR g.home = ?)")
        params += [arg(q, "team"), arg(q, "team")]
    if arg(q, "park"):
        where.append("g.park = ?"); params.append(arg(q, "park"))
    if arg(q, "gametype"):
        where.append("g.gametype = ?"); params.append(arg(q, "gametype"))
    # Everything above narrows the calendar too. `date` is the one filter that
    # must not, so it goes on last and the calendar is built from the clauses
    # standing before it.
    days = _day_counts(conn, where, params, arg(q, "team"))
    if arg(q, "date"):
        where.append("g.date = ?"); params.append(arg(q, "date"))
    limit = min(intarg(q, "limit", 200), 1000)
    sql = GAME_LIST_SQL + "".join(" AND " + w for w in where) + \
        " ORDER BY g.date, g.number, g.id LIMIT ?"
    gs = rows(conn.execute(sql, params + [limit]))
    total = one(conn.execute("SELECT COUNT(*) n FROM game g WHERE 1=1"
                             + "".join(" AND " + w for w in where), params))["n"]
    return {"games": _decorate_games(conn, gs), "total": total,
            "shown": len(gs), "days": days}


def api_game(gid, conn):
    """One game, in full: line score, both box scores, and the itemised events."""
    g = one(conn.execute("SELECT * FROM game WHERE id = ?", (gid,)))
    if not g:
        return {"error": "no such game"}
    season = g["season"]
    tnames = team_map(conn, [(g["vis"], season), (g["home"], season)])
    park = one(conn.execute("SELECT * FROM park WHERE id = ?", (g["park"],)))

    # Scalar subqueries rather than joins: a man with two pinch-hit records in
    # one game would otherwise be given two batting lines.
    batting = rows(conn.execute("""
        SELECT b.*,
               (SELECT MIN(inning) FROM pinch_hit ph
                 WHERE ph.game = b.game AND ph.person = b.person) AS ph_inning,
               (SELECT MIN(inning) FROM pinch_run pr
                 WHERE pr.game = b.game AND pr.person = b.person) AS pr_inning
        FROM bat b WHERE b.game = ? ORDER BY b.side, b.slot, b.seq""", (gid,)))
    pitching = rows(conn.execute(
        "SELECT * FROM pit WHERE game = ? ORDER BY side, seq", (gid,)))
    fielding = rows(conn.execute(
        "SELECT * FROM fld WHERE game = ? ORDER BY side, pos, seq", (gid,)))
    running = rows(conn.execute(
        "SELECT * FROM pinch_run WHERE game = ? ORDER BY side, inning", (gid,)))
    tbox = {r["side"]: dict(r) for r in conn.execute(
        "SELECT * FROM team_box WHERE game = ?", (gid,))}
    events = rows(conn.execute(
        "SELECT * FROM box_event WHERE game = ? ORDER BY kind, inning", (gid,)))

    ids = ([b["person"] for b in batting] + [p["person"] for p in pitching]
           + [f["person"] for f in fielding] + [r["person"] for r in running]
           + [g[k] for k in ("wp", "lp", "sv", "ump_hp", "ump_1b", "ump_2b",
                             "ump_3b", "ump_lf", "ump_rf", "mgr_vis", "mgr_home",
                             "vis_sp", "home_sp")])
    for e in events:
        ids += (e["players"] or "").split(",")
    names = people_map(conn, ids)
    lasts = surname_map(conn, ids)

    # positions each man played, so the box score can read "Betts rf-cf"
    pos_by_person = {}
    for f in fielding:
        pos_by_person.setdefault((f["side"], f["person"]), []).append(
            POSITIONS.get(f["pos"], str(f["pos"])))
    for b in batting:
        b["name"] = names.get(b["person"])
        b["lastName"] = lasts.get(b["person"])
        b["positions"] = pos_by_person.get((b["side"], b["person"]), [])
        b["pinchHitInning"] = b.pop("ph_inning", None)
        b["pinchRunInning"] = b.pop("pr_inning", None)
    for p in pitching:
        p["name"] = names.get(p["person"])
        p["lastName"] = lasts.get(p["person"])
        p["ip"] = "%d.%d" % (p["outs"] // 3, p["outs"] % 3) if p["outs"] is not None else None
    for f in fielding:
        f["name"] = names.get(f["person"])
        f["position"] = POSITIONS.get(f["pos"], str(f["pos"]))
    for r in running:
        r["name"] = names.get(r["person"])
    for e in events:
        parts = [x for x in (e["players"] or "").split(",") if x]
        e["playerNames"] = [names.get(x, x) for x in parts]
        e["playerLast"] = [lasts.get(x) or names.get(x, x) for x in parts]

    return {
        "game": dict(g, visName=tnames.get((g["vis"], season), g["vis"]),
                     homeName=tnames.get((g["home"], season), g["home"]),
                     gametypeLabel=GAMETYPES.get(g["gametype"], g["gametype"]),
                     visLine=(g["vis_line"] or "").split(",") if g["vis_line"] else [],
                     homeLine=(g["home_line"] or "").split(",") if g["home_line"] else []),
        "park": park,
        "people": {k: names.get(g[k]) for k in
                   ("wp", "lp", "sv", "ump_hp", "ump_1b", "ump_2b", "ump_3b",
                    "ump_lf", "ump_rf", "mgr_vis", "mgr_home", "vis_sp", "home_sp")},
        "batting": batting, "pitching": pitching, "fielding": fielding,
        "running": running, "teamBox": tbox, "events": events,
    }


BAT_TOTALS = """SUM(b.ab) ab, SUM(b.r) r, SUM(b.h) h, SUM(b.d) d, SUM(b.t) t,
                SUM(b.hr) hr, SUM(b.rbi) rbi, SUM(b.bb) bb, SUM(b.so) so,
                SUM(b.sb) sb, SUM(b.cs) cs, SUM(b.hbp) hbp, SUM(b.sh) sh,
                SUM(b.sf) sf, SUM(b.gidp) gidp, COUNT(*) g"""

PIT_TOTALS = """SUM(p.outs) outs, SUM(p.bfp) bfp, SUM(p.h) h, SUM(p.hr) hr,
                SUM(p.r) r, SUM(p.er) er, SUM(p.bb) bb, SUM(p.so) so,
                SUM(p.hbp) hbp, SUM(p.wp) wp, COUNT(*) g"""


def api_player(pid, conn):
    """Bio, plus season-by-season totals rebuilt from the box-score lines.

    Retrosheet publishes no season totals of its own -- these are summed from
    the per-game lines every time, which is why they will differ from a
    published total wherever Retrosheet's box scores differ from the official
    record. That is a statement about the source, not a rounding error, and
    the About page says so.
    """
    p = one(conn.execute("SELECT * FROM person WHERE id = ?", (pid,)))
    if not p:
        return {"error": "no such person"}

    batting = rows(conn.execute("""
        SELECT g.season, CASE b.side WHEN 0 THEN g.vis ELSE g.home END team,
               g.gametype, %s
        FROM bat b JOIN game g ON g.id = b.game
        WHERE b.person = ? GROUP BY g.season, team, g.gametype
        ORDER BY g.season, team""" % BAT_TOTALS, (pid,)))
    pitching = rows(conn.execute("""
        SELECT g.season, CASE p.side WHEN 0 THEN g.vis ELSE g.home END team,
               g.gametype, %s
        FROM pit p JOIN game g ON g.id = p.game
        WHERE p.person = ? GROUP BY g.season, team, g.gametype
        ORDER BY g.season, team""" % PIT_TOTALS, (pid,)))
    # Split by game type like batting and pitching: without it a World Series
    # ring's worth of putouts lands in the regular-season row.
    fielding = rows(conn.execute("""
        SELECT g.season, g.gametype, f.pos, COUNT(*) g, SUM(f.outs) outs,
               SUM(f.po) po, SUM(f.a) a, SUM(f.e) e, SUM(f.dp) dp, SUM(f.pb) pb
        FROM fld f JOIN game g ON g.id = f.game
        WHERE f.person = ? GROUP BY g.season, g.gametype, f.pos
        ORDER BY g.season, f.pos""", (pid,)))
    for f in fielding:
        f["position"] = POSITIONS.get(f["pos"], str(f["pos"]))

    tnames = team_map(conn, [(r["team"], r["season"]) for r in batting + pitching])
    for r in batting + pitching:
        r["teamName"] = tnames.get((r["team"], r["season"]), r["team"])

    seasons = sorted({r["season"] for r in batting + pitching})
    return {"person": dict(p, name=name_of(p)),
            "batting": batting, "pitching": pitching, "fielding": fielding,
            "seasons": seasons}


def api_player_games(pid, q, conn):
    """Every game a man appeared in, one row each -- the thing Lahman can't do."""
    where, params = ["x.person = ?"], [pid]
    if arg(q, "season"):
        where.append("g.season = ?"); params.append(intarg(q, "season"))
    sql = """
        SELECT g.id, g.date, g.season, g.gametype, g.vis, g.home,
               g.vis_score, g.home_score, g.park,
               b.ab, b.r, b.h, b.d, b.t, b.hr, b.rbi, b.bb, b.so, b.sb,
               b.hbp, b.sh, b.sf,
               p.outs p_outs, p.h p_h, p.r p_r, p.er p_er, p.bb p_bb,
               p.so p_so, p.hr p_hr,
               CASE x.side WHEN 0 THEN g.vis ELSE g.home END team,
               CASE x.side WHEN 0 THEN g.home ELSE g.vis END opp,
               x.side
        FROM (SELECT game, person, side FROM bat WHERE person = ?
              UNION SELECT game, person, side FROM pit WHERE person = ?) x
        JOIN game g ON g.id = x.game
        LEFT JOIN bat b ON b.game = x.game AND b.person = x.person
        LEFT JOIN pit p ON p.game = x.game AND p.person = x.person
        WHERE %s ORDER BY g.date, g.number""" % " AND ".join(where)
    gs = rows(conn.execute(sql, [pid, pid] + params))
    tnames = team_map(conn, [(g["team"], g["season"]) for g in gs]
                      + [(g["opp"], g["season"]) for g in gs])
    for g in gs:
        g["teamName"] = tnames.get((g["team"], g["season"]), g["team"])
        g["oppName"] = tnames.get((g["opp"], g["season"]), g["opp"])
        g["ip"] = ("%d.%d" % (g["p_outs"] // 3, g["p_outs"] % 3)
                   if g["p_outs"] is not None else None)
    return {"games": gs, "total": len(gs)}


def api_team(code, q, conn):
    """A club's season: every game in order, with a running record."""
    season = intarg(q, "season")
    if not season:
        yrs = rows(conn.execute("""SELECT season, COUNT(*) n FROM game
                                   WHERE vis = ? OR home = ? GROUP BY season
                                   ORDER BY season""", (code, code)))
        return {"team": code, "seasons": yrs}
    info = one(conn.execute("SELECT * FROM team WHERE id = ? AND season = ?",
                            (code, season)))
    gs = rows(conn.execute("""
        SELECT id, date, number, gametype, vis, home, vis_score, home_score,
               park, attendance, has_box
        FROM game WHERE (vis = ? OR home = ?) AND season = ?
        ORDER BY date, number""", (code, code, season)))
    # A season's games include October. Counting the World Series into the
    # regular-season record turns the 1927 Yankees into a 114-44 club, so the
    # running record advances on regular-season games only and every other
    # game type is totalled separately.
    tally = {}
    tnames = team_map(conn, [(g["vis"], season) for g in gs]
                      + [(g["home"], season) for g in gs])
    for g in gs:
        home = g["home"] == code
        us = g["home_score"] if home else g["vis_score"]
        them = g["vis_score"] if home else g["home_score"]
        g["us"], g["them"] = us, them
        g["opp"] = g["vis"] if home else g["home"]
        g["oppName"] = tnames.get((g["opp"], season), g["opp"])
        g["atHome"] = home
        rec = tally.setdefault(g["gametype"], {"w": 0, "l": 0, "t": 0})
        if us is None or them is None:
            g["result"] = None
        elif us > them:
            rec["w"] += 1; g["result"] = "W"
        elif us < them:
            rec["l"] += 1; g["result"] = "L"
        else:
            rec["t"] += 1; g["result"] = "T"
        g["record"] = ("%d-%d%s" % (rec["w"], rec["l"], "-%d" % rec["t"] if rec["t"] else "")
                       if g["gametype"] == "regular" else None)
    roster = rows(conn.execute("""
        SELECT r.person, r.pos, r.bats, r.throws, p.first, p.last, p.nickname
        FROM roster r LEFT JOIN person p ON p.id = r.person
        WHERE r.team = ? AND r.season = ? ORDER BY p.last, p.first""",
                               (code, season)))
    for r in roster:
        r["name"] = name_of(r)
    return {"team": code, "season": season, "info": info, "games": gs,
            "record": tally.get("regular", {"w": 0, "l": 0, "t": 0}),
            "records": {k: dict(v, label=GAMETYPES.get(k, k))
                        for k, v in tally.items()},
            "roster": roster}


def api_day(date, conn):
    gs = rows(conn.execute(GAME_LIST_SQL + " AND g.date = ? ORDER BY g.gametype, g.id",
                           (date,)))
    return {"date": date, "games": _decorate_games(conn, gs)}


def api_park(park_id, conn):
    p = one(conn.execute("SELECT * FROM park WHERE id = ?", (park_id,)))
    if not p:
        return {"error": "no such park"}
    span = one(conn.execute("""SELECT MIN(season) a, MAX(season) b, COUNT(*) n,
                               SUM(attendance) att FROM game WHERE park = ?""",
                            (park_id,)))
    by_season = rows(conn.execute("""SELECT season, COUNT(*) n,
                                     CAST(AVG(attendance) AS INT) avg_att FROM game
                                     WHERE park = ? GROUP BY season ORDER BY season""",
                                  (park_id,)))
    return {"park": p, "span": span, "bySeason": by_season}


def api_teams(q, conn):
    season = intarg(q, "season")
    if season:
        # allstar = a squad whose every game that season was an All-Star game.
        # Deliberately not a match on ALS/NLS or on the words "All Stars":
        # the 1927 Baltimore All Stars and Pirrone All Stars played real games
        # against the Homestead Grays, and a rule of "played no regular-season
        # game" would demote the Grays themselves, since Negro League games
        # are typed 'negro' rather than 'regular'.
        return {"teams": rows(conn.execute("""
            SELECT t.id, t.league, t.city, t.nickname,
                   (SELECT COUNT(*) FROM game g
                    WHERE (g.vis = t.id OR g.home = t.id) AND g.season = t.season) n,
                   (SELECT COUNT(*) FROM game g
                    WHERE (g.vis = t.id OR g.home = t.id) AND g.season = t.season
                      AND g.gametype <> 'allstar') = 0 AS allstar
            FROM team t WHERE t.season = ? AND n > 0
            ORDER BY allstar, t.league, t.city""", (season,)))}
    return {"franchises": rows(conn.execute(
        "SELECT * FROM franchise ORDER BY first, id"))}


ROUTES = {
    "/api/meta": lambda q, c: api_meta(q, c),
    "/api/search": lambda q, c: api_search(q, c),
    "/api/games": lambda q, c: api_games(q, c),
    "/api/teams": lambda q, c: api_teams(q, c),
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        # A development server that lets the browser cache app.js and style.css
        # spends its life showing you the previous edit. Nothing here is served
        # to the public, so there is nothing to trade away by refusing to cache.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        path, q = u.path, parse_qs(u.query)
        if not path.startswith("/api/"):
            if path != "/" and not os.path.exists(os.path.join(STATIC, path.lstrip("/"))):
                self.path = "/"          # client-side routing: everything else is the app
            return super().do_GET()
        conn = db()
        try:
            if path in ROUTES:
                return self.send_json(ROUTES[path](q, conn))
            m = re.match(r"^/api/game/([A-Z0-9]+)$", path)
            if m:
                return self.send_json(api_game(m.group(1), conn))
            m = re.match(r"^/api/player/([a-z0-9]+)/games$", path)
            if m:
                return self.send_json(api_player_games(m.group(1), q, conn))
            m = re.match(r"^/api/player/([a-z0-9]+)$", path)
            if m:
                return self.send_json(api_player(m.group(1), conn))
            m = re.match(r"^/api/team/([A-Z0-9]+)$", path)
            if m:
                return self.send_json(api_team(m.group(1), q, conn))
            m = re.match(r"^/api/day/(\d{4}-\d{2}-\d{2})$", path)
            if m:
                return self.send_json(api_day(m.group(1), conn))
            m = re.match(r"^/api/park/([A-Z0-9]+)$", path)
            if m:
                return self.send_json(api_park(m.group(1), conn))
            self.send_json({"error": "unknown endpoint: %s" % path}, 404)
        except Exception as exc:                       # noqa: BLE001
            self.send_json({"error": "%s: %s" % (type(exc).__name__, exc)}, 500)
        finally:
            conn.close()


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--lan", action="store_true", help="listen on all interfaces")
    args = ap.parse_args()
    if not os.path.exists(DB_PATH):
        sys.exit("No database at %s -- run build_db.py first." % DB_PATH)
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    srv = ThreadingHTTPServer((host, args.port), Handler)
    shown = lan_ip() if args.lan else "127.0.0.1"
    print("Baseball Games -> http://%s:%d" % (shown, args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
