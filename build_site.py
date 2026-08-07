#!/usr/bin/env python3
"""Build the serverless site into docs/, for GitHub Pages.

The same frontend as static/, but with api-local.js standing in for app.py:
every endpoint is reimplemented in the browser over exported JSON, so app.js
runs unchanged and the two can't drift apart in behaviour.

The exports are columnar -- one shared list of column names, then rows as
plain arrays. Repeating the key name on all 5.6 million batting lines costs
about 700 MB of JSON and buys nothing, since the reader knows the shape.

Data is sharded by season because that is how the app is actually used: you
look at 1927, not at all 155 seasons at once. A visitor downloads one file of
roughly half a megabyte rather than the whole corpus. The three things that
genuinely span seasons -- name search, career totals and per-park history --
are precomputed into their own files instead.

Usage: python3 build_site.py
"""
import json
import os
import shutil
import sqlite3
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE, "retro.sqlite")
STATIC = os.path.join(BASE, "static")
DOCS = os.path.join(BASE, "docs")
DATA = os.path.join(DOCS, "data")
SEASONS = os.path.join(DATA, "season")
CAREERS = os.path.join(DATA, "careers")

# Only what a view actually renders. The game page shows batting, pitching and
# the itemised events; it does not show fielding lines, pinch-running or team
# totals, and carrying them would roughly double every shard for nothing.
GAME_COLS = ("id,date,number,gametype,vis,home,vis_score,home_score,park,"
             "attendance,duration,vis_line,home_line,has_box,has_pbp,daynight,"
             "temp,sky,wind_speed,start_time,ump_hp,ump_1b,ump_2b,ump_3b,"
             "mgr_vis,mgr_home,wp,lp,sv,vis_sp,home_sp,v_h,v_e,h_h,h_e")
# No slot or seq: the box score prints batters in lineup order, and the export
# is already written in that order, so the array index carries it for free.
BAT_COLS = "person,side,ab,r,h,d,t,hr,rbi,bb,so,sb"
PIT_COLS = "person,side,seq,outs,h,r,er,bb,so,hr,bfp"

total_bytes = 0


def write(path, obj):
    global total_bytes
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))
    total_bytes += os.path.getsize(path)
    return os.path.getsize(path)


def cols(spec):
    return spec.split(",")


def report(label, path, extra=""):
    kb = os.path.getsize(path) / 1024
    print("  %-22s %9.1f KB  %s" % (label, kb, extra))


# ------------------------------------------------------------------- exports

def export_people(conn):
    """The search index: everyone, with just enough to rank and label them."""
    rows = conn.execute("""
        SELECT p.id, p.first, p.last, p.nickname, p.hof,
               p.play_debut, p.play_last, p.mgr_debut, p.ump_debut,
               (SELECT COUNT(*) FROM bat b WHERE b.person = p.id)
             + (SELECT COUNT(*) FROM pit t WHERE t.person = p.id) AS games
        FROM person p ORDER BY p.id""").fetchall()
    path = os.path.join(DATA, "people.json")
    write(path, {"c": ["id", "first", "last", "nickname", "hof", "debut",
                       "lastGame", "mgrDebut", "umpDebut", "games"],
                 "r": [list(r) for r in rows]})
    report("people.json", path, "%s people" % f"{len(rows):,}")


def export_bio(conn):
    """The fuller biography, only needed once a player page is open."""
    rows = conn.execute("""
        SELECT id, bats, throws, height, weight, birthdate, birth_city,
               birth_state, birth_country, deathdate, birth_name
        FROM person ORDER BY id""").fetchall()
    path = os.path.join(DATA, "bio.json")
    write(path, {"c": ["id", "bats", "throws", "height", "weight", "birthdate",
                       "birthCity", "birthState", "birthCountry", "deathdate",
                       "birthName"],
                 "r": [list(r) for r in rows]})
    report("bio.json", path)


def export_careers(conn):
    """Season-by-season totals -- the player page, without loading 22 shards."""
    bat = conn.execute("""
        SELECT b.person, g.season, CASE b.side WHEN 0 THEN g.vis ELSE g.home END,
               g.gametype, COUNT(*), SUM(b.ab), SUM(b.r), SUM(b.h), SUM(b.d),
               SUM(b.t), SUM(b.hr), SUM(b.rbi), SUM(b.bb), SUM(b.so), SUM(b.sb)
        FROM bat b JOIN game g ON g.id = b.game
        GROUP BY b.person, g.season, 3, g.gametype
        ORDER BY b.person, g.season""").fetchall()
    pit = conn.execute("""
        SELECT p.person, g.season, CASE p.side WHEN 0 THEN g.vis ELSE g.home END,
               g.gametype, COUNT(*), SUM(p.outs), SUM(p.h), SUM(p.r), SUM(p.er),
               SUM(p.bb), SUM(p.so), SUM(p.hr)
        FROM pit p JOIN game g ON g.id = p.game
        GROUP BY p.person, g.season, 3, g.gametype
        ORDER BY p.person, g.season""").fetchall()
    fld = conn.execute("""
        SELECT f.person, g.season, f.pos, COUNT(*), SUM(f.outs), SUM(f.po),
               SUM(f.a), SUM(f.e), SUM(f.dp), SUM(f.pb)
        FROM fld f JOIN game g ON g.id = f.game
        GROUP BY f.person, g.season, f.pos
        ORDER BY f.person, g.season, f.pos""").fetchall()
    # Sharded on the player id's first character, which is the initial of his
    # surname. One file is 18 MB and every player page would pay for it;
    # twenty-six are well under a megabyte each and a page loads only the one.
    os.makedirs(CAREERS, exist_ok=True)
    shards = {}
    for key, data in (("bat", bat), ("pit", pit), ("fld", fld)):
        for r in data:
            shards.setdefault(r[0][0], {"bat": [], "pit": [], "fld": []})[key].append(list(r))
    biggest = 0
    for letter, d in shards.items():
        path = os.path.join(CAREERS, letter + ".json")
        size = write(path, {
            "batC": ["person", "season", "team", "gametype", "g", "ab", "r", "h",
                     "d", "t", "hr", "rbi", "bb", "so", "sb"], "bat": d["bat"],
            "pitC": ["person", "season", "team", "gametype", "g", "outs", "h", "r",
                     "er", "bb", "so", "hr"], "pit": d["pit"],
            "fldC": ["person", "season", "pos", "g", "outs", "po", "a", "e", "dp", "pb"],
            "fld": d["fld"]})
        biggest = max(biggest, size)
    print("  %-22s %9.1f KB  %s"
          % ("careers/ (%d shards)" % len(shards), biggest / 1024,
             "largest; %s batting rows in all" % f"{len(bat):,}"))


def export_reference(conn):
    teams = conn.execute(
        "SELECT id, season, league, city, nickname FROM team ORDER BY season, id").fetchall()
    # which seasons a club actually played, so the team page needs no scan
    played = conn.execute("""
        SELECT t, season, COUNT(*) FROM (
            SELECT vis AS t, season FROM game
            UNION ALL SELECT home, season FROM game)
        GROUP BY t, season ORDER BY t, season""").fetchall()
    path = os.path.join(DATA, "teams.json")
    write(path, {"c": ["id", "season", "league", "city", "nickname"],
                 "r": [list(r) for r in teams],
                 "playedC": ["team", "season", "games"],
                 "played": [list(r) for r in played]})
    report("teams.json", path, "%s team-seasons" % f"{len(teams):,}")

    parks = conn.execute(
        'SELECT id, name, aka, city, state, start, "end", notes FROM park ORDER BY id').fetchall()
    by_season = conn.execute("""
        SELECT park, season, COUNT(*), CAST(AVG(attendance) AS INT)
        FROM game WHERE park IS NOT NULL
        GROUP BY park, season ORDER BY park, season""").fetchall()
    path = os.path.join(DATA, "parks.json")
    write(path, {"c": ["id", "name", "aka", "city", "state", "start", "end", "notes"],
                 "r": [list(r) for r in parks],
                 "seasonC": ["park", "season", "games", "avgAtt"],
                 "season": [list(r) for r in by_season]})
    report("parks.json", path, "%s parks" % len(parks))


def export_season(conn, season):
    """One season: its games and the box-score lines belonging to them.

    Game ids are replaced by their index in the games list. The id is 13
    characters and repeats on every batting line; the index is one or two
    digits, and the reader can map back.
    """
    games = conn.execute(
        "SELECT %s FROM game WHERE season = ? ORDER BY date, number, id"
        % GAME_COLS, (season,)).fetchall()
    idx = {g[0]: i for i, g in enumerate(games)}
    ids = list(idx)
    if not ids:
        return None
    q = ",".join("?" * len(ids))

    # The positions a man played, folded onto his batting row rather than kept
    # as a table of its own: the box score prints "rf-cf" beside his name and
    # never shows his putouts, and a separate table repeats the game, player
    # and side on every row to say one short string.
    pos = {}
    for gid, person, side, p in conn.execute(
            "SELECT game, person, side, pos FROM fld WHERE game IN (%s) "
            "ORDER BY game, person, seq" % q, ids):
        pos.setdefault((gid, person, side), []).append(p)
    bat = [[idx[r[0]]] + list(r[1:])
           + ["-".join(str(x) for x in pos.get((r[0], r[1], r[2]), [])) or None]
           for r in conn.execute(
        "SELECT game,%s FROM bat WHERE game IN (%s) ORDER BY game, side, slot, seq"
        % (BAT_COLS, q), ids)]
    pit = [[idx[r[0]]] + list(r[1:]) for r in conn.execute(
        "SELECT game,%s FROM pit WHERE game IN (%s) ORDER BY game, side, seq"
        % (PIT_COLS, q), ids)]
    ph = [[idx[r[0]], r[1], r[2]] for r in conn.execute(
        "SELECT game, person, inning FROM pinch_hit WHERE game IN (%s)" % q, ids)]
    bev = [[idx[r[0]]] + list(r[1:]) for r in conn.execute(
        "SELECT game, kind, side, players, inning, runners_on, outs "
        "FROM box_event WHERE game IN (%s) ORDER BY game, kind" % q, ids)]
    roster = [list(r) for r in conn.execute(
        "SELECT team, person, pos, bats, throws FROM roster WHERE season = ? "
        "ORDER BY team, person", (season,))]

    path = os.path.join(SEASONS, "%d.json" % season)
    size = write(path, {
        "season": season,
        "gameC": cols(GAME_COLS), "games": [list(g) for g in games],
        "batC": ["g"] + cols(BAT_COLS) + ["pos"], "bat": bat,
        "pitC": ["g"] + cols(PIT_COLS), "pit": pit,
        "phC": ["g", "person", "inning"], "ph": ph,
        "bevC": ["g", "kind", "side", "players", "inning", "on", "outs"], "bev": bev,
        "rosC": ["team", "person", "pos", "bats", "throws"], "ros": roster})
    return len(games), len(bat), size


def export_meta(conn, seasons):
    m = conn.execute("SELECT COUNT(*), SUM(has_box), SUM(has_pbp), "
                     "MIN(season), MAX(season) FROM game").fetchone()
    path = os.path.join(DATA, "meta.json")
    write(path, {"firstSeason": m[3], "lastSeason": m[4], "games": m[0],
                 "withBox": m[1], "withPlays": m[2], "seasons": seasons,
                 "gametypes": {"regular": "Regular season",
                               "worldseries": "World Series",
                               "lcs": "League Championship Series",
                               "division": "Division Series",
                               "wildcard": "Wild Card",
                               "allstar": "All-Star Game",
                               "negro": "Negro Leagues"}})
    report("meta.json", path)


# -------------------------------------------------------------------- frontend

def copy_frontend():
    """static/ verbatim, plus the local API and the script tag that loads it."""
    for name in ("app.js", "style.css", "api-local.js"):
        shutil.copy(os.path.join(STATIC, name), os.path.join(DOCS, name))
    html = open(os.path.join(STATIC, "index.html"), encoding="utf-8").read()
    if "api-local.js" not in html:
        html = html.replace('<script src="/app.js"></script>',
                            '<script src="api-local.js"></script>\n'
                            '<script src="app.js"></script>')
    # Pages serves from a subdirectory, so absolute asset paths would 404
    html = html.replace('href="/style.css"', 'href="style.css"')
    open(os.path.join(DOCS, "index.html"), "w", encoding="utf-8").write(html)
    open(os.path.join(DOCS, ".nojekyll"), "w").close()
    print("  frontend copied, index.html rewritten for a subdirectory")


def main():
    if not os.path.exists(DB_PATH):
        sys.exit("No database at %s -- run build_db.py first." % DB_PATH)
    if not os.path.exists(os.path.join(STATIC, "api-local.js")):
        sys.exit("static/api-local.js is missing -- the site cannot run without it.")
    shutil.rmtree(DOCS, ignore_errors=True)
    os.makedirs(SEASONS)
    conn = sqlite3.connect(DB_PATH)

    print("Cross-season exports")
    export_people(conn)
    export_bio(conn)
    export_careers(conn)
    export_reference(conn)

    print("Season shards")
    seasons = [r[0] for r in conn.execute(
        "SELECT DISTINCT season FROM game ORDER BY season")]
    biggest = (0, None)
    done = 0
    for s in seasons:
        out = export_season(conn, s)
        if out:
            done += 1
            if out[2] > biggest[0]:
                biggest = (out[2], s)
    print("  %d shards, largest %d at %.1f KB" % (done, biggest[1], biggest[0] / 1024))

    export_meta(conn, seasons)
    print("Frontend")
    copy_frontend()
    conn.close()

    print("\ndocs/ is %.0f MB across %d files"
          % (total_bytes / 1e6, sum(len(f) for _, _, f in os.walk(DOCS))))
    print("Serve locally with:  python3 -m http.server -d docs 8001")


if __name__ == "__main__":
    main()
