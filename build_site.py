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
import gzip
import hashlib
import json
import os
import shutil
import sqlite3
import sys

GAMETYPE_ORDER = ["regular", "playoff", "wildcard", "division", "lcs",
                  "championship", "worldseries", "allstar", "exhibition"]

# app.py's LEAGUE_ORDER and LEAGUES. MLB leads where it exists; before 1901 the
# senior circuit leads because MLB is simply not in that season's list.
LEAGUE_ORDER = ["MLB", "NL", "AA", "PL", "UA", "NA", "FL",
                "NN1", "NN2", "NAL", "ECL", "ANL", "EW", "NSL"]

LEAGUES = {"MLB": "Major Leagues", "NL": "National League",
           "AL": "American League", "AA": "American Association",
           "PL": "Players' League", "UA": "Union Association",
           "NA": "National Association", "FL": "Federal League",
           "NN1": "Negro National League", "NN2": "Negro National League II",
           "NAL": "Negro American League", "ECL": "Eastern Colored League",
           "ANL": "American Negro League", "EW": "East-West League",
           "NSL": "Negro Southern League"}

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE, "retro.sqlite")
STATIC = os.path.join(BASE, "static")
DOCS = os.path.join(BASE, "docs")
DATA = os.path.join(DOCS, "data")
SEASONS = os.path.join(DATA, "season")
CAREERS = os.path.join(DATA, "careers")
PLAYS = os.path.join(DATA, "plays")

# Only what a view actually renders. The game page shows batting, pitching and
# the itemised events; it does not show fielding lines, pinch-running or team
# totals, and carrying them would roughly double every shard for nothing.
GAME_COLS = ("id,date,number,gametype,vis,home,vis_score,home_score,park,"
             "attendance,duration,vis_line,home_line,has_box,has_pbp,daynight,"
             # wind_dir was missing here while the view rendered it, so the
             # published site read "12 mph" where app.py read "12 mph, tocf"
             # -- 72,740 games with a direction, and no fixture comparing a
             # weather field to notice.
             "temp,sky,wind_speed,wind_dir,start_time,ump_hp,ump_1b,ump_2b,ump_3b,"
             # The outfield pair is only used by a six-man crew -- 1,947 games,
             # all of them October or the All-Star Game -- but dropping them
             # cost Larsen's perfect game two of its six umpires here while
             # app.py named all six, and put an umpire's own World Series
             # games outside his log.
             "ump_lf,ump_rf,"
             # A league on each side, because a game between two leagues
             # belongs to both and `league` cannot say so.
             "vis_lg,home_lg,"
             "mgr_vis,mgr_home,wp,lp,sv,vis_sp,home_sp,v_h,v_e,h_h,h_e")
# seq is dropped -- the export is written in lineup order, so the array index
# carries it. slot is kept because it is not decoration: Retrosheet writes 0
# for a man who was in the game but never in the batting order, which since
# the DH means the pitchers, and a box score does not list them among the
# batters. 443,264 such rows, not one with a plate appearance.
BAT_COLS = "person,side,slot,ab,r,h,d,t,hr,rbi,bb,so,sb"
PIT_COLS = "person,side,seq,outs,h,r,er,bb,so,hr,bfp,hbp,wp,bk"

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
               birth_state, birth_country, deathdate, birth_name,
               mgr_debut, mgr_last, coach_debut, coach_last, ump_debut, ump_last
        FROM person ORDER BY id""").fetchall()
    path = os.path.join(DATA, "bio.json")
    write(path, {"c": ["id", "bats", "throws", "height", "weight", "birthdate",
                       "birthCity", "birthState", "birthCountry", "deathdate",
                       "birthName", "mgrDebut", "mgrLast", "coachDebut",
                       "coachLast", "umpDebut", "umpLast"],
                 "r": [list(r) for r in rows]})
    report("bio.json", path)


def export_careers(conn):
    """Season-by-season totals -- the player page, without loading 22 shards."""
    bat = conn.execute("""
        SELECT b.person, g.season, CASE b.side WHEN 0 THEN g.vis ELSE g.home END,
               g.gametype, COUNT(*), SUM(b.ab), SUM(b.r), SUM(b.h), SUM(b.d),
               SUM(b.t), SUM(b.hr), SUM(b.rbi), SUM(b.bb), SUM(b.so), SUM(b.sb),
               SUM(b.cs), SUM(b.hbp), SUM(b.sh), SUM(b.sf), SUM(b.gidp)
        FROM bat b JOIN game g ON g.id = b.game
        GROUP BY b.person, g.season, 3, g.gametype
        ORDER BY b.person, g.season""").fetchall()
    pit = conn.execute("""
        SELECT p.person, g.season, CASE p.side WHEN 0 THEN g.vis ELSE g.home END,
               g.gametype, COUNT(*), SUM(p.outs), SUM(p.h), SUM(p.r), SUM(p.er),
               SUM(p.bb), SUM(p.so), SUM(p.hr), SUM(p.bfp), SUM(p.hbp), SUM(p.wp)
        FROM pit p JOIN game g ON g.id = p.game
        GROUP BY p.person, g.season, 3, g.gametype
        ORDER BY p.person, g.season""").fetchall()
    # app.py's PIT_DECISIONS, for everyone at once. Same shape, same answers --
    # test_local_api.js is what holds the two to it.
    dec = {r[:4]: r[4:] for r in conn.execute("""
        WITH mine AS (
          SELECT game, side, person, MIN(seq) seq, SUM(r) r
          FROM pit GROUP BY game, side, person),
        staff AS (
          SELECT game, side, COUNT(DISTINCT person) n FROM pit GROUP BY game, side)
        SELECT m.person, g.season,
               CASE m.side WHEN 0 THEN g.vis ELSE g.home END, g.gametype,
               SUM(g.wp IS m.person), SUM(g.lp IS m.person), SUM(g.sv IS m.person),
               SUM(m.seq = 1), SUM(s.n = 1),
               SUM(CASE WHEN s.n = 1 AND m.r = 0 THEN 1 ELSE 0 END)
        FROM mine m JOIN game g ON g.id = m.game
        JOIN staff s ON s.game = m.game AND s.side = m.side
        GROUP BY m.person, g.season, 3, g.gametype""")}
    pit = [list(r) + list(dec.get(tuple(r[:4]), (0, 0, 0, 0, 0, 0))) for r in pit]
    fld = conn.execute("""
        SELECT f.person, g.season, g.gametype, f.pos, COUNT(*), SUM(f.outs),
               SUM(f.po), SUM(f.a), SUM(f.e), SUM(f.dp), SUM(f.tp), SUM(f.pb)
        FROM fld f JOIN game g ON g.id = f.game
        GROUP BY f.person, g.season, g.gametype, f.pos
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
                     "d", "t", "hr", "rbi", "bb", "so", "sb", "cs", "hbp", "sh",
                     "sf", "gidp"],
            "bat": d["bat"],
            "pitC": ["person", "season", "team", "gametype", "g", "outs", "h", "r",
                     "er", "bb", "so", "hr", "bfp", "hbp", "wp",
                     "w", "l", "sv", "gs", "cg", "sho"], "pit": d["pit"],
            "fldC": ["person", "season", "gametype", "pos", "g", "outs", "po",
                     "a", "e", "dp", "tp", "pb"],
            "fld": d["fld"]})
        biggest = max(biggest, size)
    print("  %-22s %9.1f KB  %s"
          % ("careers/ (%d shards)" % len(shards), biggest / 1024,
             "largest; %s batting rows in all" % f"{len(bat):,}"))


def export_roles(conn):
    """Managing and umpiring records -- app.py's MGR_RECORD and UMP_RECORD for
    everyone at once. 2,709 people in the database never played a game, and
    without this their pages are a name and a birthplace. Small enough to go
    unsharded: 5,100 managing rows and 9,670 umpiring ones against the 140,780
    batting rows that needed twenty-six files."""
    mgr = conn.execute("""
        SELECT p, season, team, gametype, COUNT(*), SUM(w), SUM(l), SUM(t)
        FROM (SELECT mgr_home p, season, home team, gametype,
                     CASE WHEN home_score > vis_score THEN 1 ELSE 0 END w,
                     CASE WHEN home_score < vis_score THEN 1 ELSE 0 END l,
                     CASE WHEN home_score = vis_score THEN 1 ELSE 0 END t
              FROM game WHERE mgr_home IS NOT NULL
              UNION ALL
              SELECT mgr_vis, season, vis, gametype,
                     CASE WHEN vis_score > home_score THEN 1 ELSE 0 END,
                     CASE WHEN vis_score < home_score THEN 1 ELSE 0 END,
                     CASE WHEN home_score = vis_score THEN 1 ELSE 0 END
              FROM game WHERE mgr_vis IS NOT NULL)
        GROUP BY p, season, team, gametype ORDER BY p, season, team""").fetchall()
    ump = conn.execute("""
        SELECT p, season, gametype, COUNT(*),
               SUM(pos = 'HP'), SUM(pos = '1B'), SUM(pos = '2B'),
               SUM(pos = '3B'), SUM(pos = 'LF'), SUM(pos = 'RF')
        FROM (SELECT ump_hp p, season, gametype, 'HP' pos FROM game WHERE ump_hp IS NOT NULL
              UNION ALL SELECT ump_1b, season, gametype, '1B' FROM game WHERE ump_1b IS NOT NULL
              UNION ALL SELECT ump_2b, season, gametype, '2B' FROM game WHERE ump_2b IS NOT NULL
              UNION ALL SELECT ump_3b, season, gametype, '3B' FROM game WHERE ump_3b IS NOT NULL
              UNION ALL SELECT ump_lf, season, gametype, 'LF' FROM game WHERE ump_lf IS NOT NULL
              UNION ALL SELECT ump_rf, season, gametype, 'RF' FROM game WHERE ump_rf IS NOT NULL)
        GROUP BY p, season, gametype ORDER BY p, season""").fetchall()
    path = os.path.join(DATA, "roles.json")
    write(path, {
        "mgrC": ["person", "season", "team", "gametype", "g", "w", "l", "t"],
        "mgr": [list(r) for r in mgr],
        "umpC": ["person", "season", "gametype", "g", "hp", "b1", "b2", "b3",
                 "lf", "rf"],
        "ump": [list(r) for r in ump]})
    report("roles.json", path,
           "%s managing, %s umpiring rows" % (f"{len(mgr):,}", f"{len(ump):,}"))


def export_plays(conn):
    """The play-by-play, sharded the way Retrosheet shards it and gzipped.

    Two decisions, both forced by numbers. The shard is one home club's season
    -- Retrosheet's own unit, 2019BOS.EVA -- because a whole season is 6.5 MB
    to show one game's ninety plays, where a club's season is 220 KB.

    And it is written compressed because GitHub Pages caps a published site at
    1 GB. Plain, these 18.3 million plays are 889 MB, more than the whole of
    the rest of the site; gzipped they are 115. It buys nothing on download --
    Pages gzips in transit anyway -- and everything on fitting.

    The substitutions ride on the play they were made at, as [person, pos,
    side], because that play is the only thing that places them in the game --
    and because seq is not exported: the shard's row order is the sequence, so
    a sub in a table of its own would have nothing to key against.
    """
    os.makedirs(PLAYS, exist_ok=True)
    at = {}
    for gid, seq, person, pos, side in conn.execute(
            "SELECT game, seq, person, pos, side FROM sub "
            "ORDER BY game, seq, rowid"):
        at.setdefault((gid, seq), []).append([person, pos, side])
    shards, biggest, total = {}, 0, 0
    for gid, seq, inning, side, batter, count, event in conn.execute(
            "SELECT game, seq, inning, side, batter, count, event FROM play "
            "ORDER BY game, seq"):
        shards.setdefault(gid[:3] + gid[3:7], []).append(
            [gid, inning, side, batter, count, event, at.get((gid, seq))])
    for key, rows_ in shards.items():
        path = os.path.join(PLAYS, key + ".json.gz")
        blob = json.dumps({"c": ["game", "inning", "side", "batter", "count",
                                 "event", "sub"], "r": rows_},
                          separators=(",", ":")).encode("utf-8")
        # mtime=0 and an empty name, so the same plays compress to the same
        # bytes. gzip stamps the clock into its header by default, which made
        # every build rewrite all 2,982 shards -- 115 MB of new blobs in a
        # committed docs/ for data that had not changed.
        with open(path, "wb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9,
                               mtime=0, filename="") as f:
                f.write(blob)
        size = os.path.getsize(path)
        total += size
        biggest = max(biggest, size)
    global total_bytes
    total_bytes += total
    print("  %-22s %9.1f KB  %s"
          % ("plays/ (%d shards)" % len(shards), biggest / 1024,
             "largest; %.0f MB in all, %s plays"
             % (total / 1048576, f"{sum(len(v) for v in shards.values()):,}")))


def export_notable():
    """The notable games, from app.py itself rather than from a copy of it.

    Every other export restates its query here and leans on test_views.sh to
    prove the two agree. These four definitions are too fiddly for that: a
    `>= 27` that became `= 27` on one side, or a play-by-play check dropped
    from this half, would be a disagreement no fixture would notice. So this
    calls the reference implementation and writes down what it answered.
    """
    import app
    path = os.path.join(DATA, "notable.json")
    d = app.api_notable(app.db())
    write(path, d)
    report("notable.json", path,
           ", ".join("%s %s" % (k["n"], k["label"].lower()) for k in d["kinds"]))


def export_reference(conn):
    teams = conn.execute(
        "SELECT id, season, league, city, nickname FROM team ORDER BY season, id").fetchall()
    # which seasons a club actually played, so the team page needs no scan
    played = conn.execute("""
        SELECT t, season, COUNT(*),
               SUM(CASE WHEN gametype <> 'allstar' THEN 1 ELSE 0 END) = 0 AS allstar
        FROM (SELECT vis AS t, season, gametype FROM game
              UNION ALL SELECT home, season, gametype FROM game)
        GROUP BY t, season ORDER BY t, season""").fetchall()
    path = os.path.join(DATA, "teams.json")
    write(path, {"c": ["id", "season", "league", "city", "nickname"],
                 "r": [list(r) for r in teams],
                 "playedC": ["team", "season", "games", "allstar"],
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
    # Sacrifices, hit batsmen, caught stealing and double plays grounded into
    # are zero for most batters in most games, so only the rows that have one
    # are exported. Absent means none, which is what the reader assumes.
    batx = [[idx[r[0]]] + list(r[1:]) for r in conn.execute(
        "SELECT game, person, sh, sf, hbp, cs, gidp FROM bat WHERE game IN (%s) "
        "AND (sh > 0 OR sf > 0 OR hbp > 0 OR cs > 0 OR gidp > 0)" % q, ids)]
    ph = [[idx[r[0]], r[1], r[2]] for r in conn.execute(
        "SELECT game, person, inning FROM pinch_hit WHERE game IN (%s)" % q, ids)]
    pr = [[idx[r[0]], r[1], r[2]] for r in conn.execute(
        "SELECT game, person, inning FROM pinch_run WHERE game IN (%s)" % q, ids)]
    bev = [[idx[r[0]]] + list(r[1:]) for r in conn.execute(
        "SELECT game, kind, side, players, inning, runners_on, outs "
        "FROM box_event WHERE game IN (%s) ORDER BY game, kind" % q, ids)]
    tbox = [[idx[r[0]]] + list(r[1:]) for r in conn.execute(
        "SELECT game, side, lob FROM team_box WHERE game IN (%s)" % q, ids)]
    roster = [list(r) for r in conn.execute(
        "SELECT team, person, pos, bats, throws FROM roster WHERE season = ? "
        "ORDER BY team, person", (season,))]

    path = os.path.join(SEASONS, "%d.json" % season)
    size = write(path, {
        "season": season,
        "gameC": cols(GAME_COLS), "games": [list(g) for g in games],
        "batC": ["g"] + cols(BAT_COLS) + ["pos"], "bat": bat,
        "pitC": ["g"] + cols(PIT_COLS), "pit": pit,
        "batxC": ["g", "person", "sh", "sf", "hbp", "cs", "gidp"], "batx": batx,
        "phC": ["g", "person", "inning"], "ph": ph,
        "prC": ["g", "person", "inning"], "pr": pr,
        "bevC": ["g", "kind", "side", "players", "inning", "on", "outs"], "bev": bev,
        "tboxC": ["g", "side", "lob"], "tbox": tbox,
        "rosC": ["team", "person", "pos", "bats", "throws"], "ros": roster})
    return len(games), len(bat), size


def export_meta(conn, seasons):
    m = conn.execute("SELECT COUNT(*), SUM(has_box), SUM(has_pbp), "
                     "MIN(season), MAX(season) FROM game").fetchone()
    by_season = {}
    for season, gametype in conn.execute(
            "SELECT DISTINCT season, gametype FROM game ORDER BY season"):
        by_season.setdefault(season, []).append(gametype)
    for v in by_season.values():
        v.sort(key=lambda g: GAMETYPE_ORDER.index(g) if g in GAMETYPE_ORDER else 99)
    # app.py's api_meta, for the same reason: 113 of the 155 seasons had one
    # league and the control has nothing to offer there.
    lg_season = {}
    for season, vis_lg, home_lg in conn.execute(
            "SELECT DISTINCT season, vis_lg, home_lg FROM game"):
        for code in (vis_lg, home_lg):
            g = ("MLB" if season >= 1901 and code in ("AL", "NL", "ML")
                 else code)
            if g:
                lg_season.setdefault(season, set()).add(g)
    by_league = {s: sorted(v, key=lambda l: LEAGUE_ORDER.index(l)
                           if l in LEAGUE_ORDER else 99)
                 for s, v in lg_season.items()}
    path = os.path.join(DATA, "meta.json")
    write(path, {"firstSeason": m[3], "lastSeason": m[4], "games": m[0],
                 "withBox": m[1], "withPlays": m[2], "seasons": seasons,
                 "seasonTypes": by_season,
                 "gametypes": {"regular": "Regular season",
                               "worldseries": "World Series",
                               "lcs": "League Championship Series",
                               "division": "Division Series",
                               "wildcard": "Wild Card",
                               "championship": "Championship series",
                               "playoff": "Playoff",
                               "exhibition": "Exhibition",
                               "allstar": "All-Star Game"},
                 "leagues": LEAGUES, "seasonLeagues": by_league})
    report("meta.json", path)


# -------------------------------------------------------------------- frontend

def copy_frontend():
    """static/ verbatim, plus the local API and the script tag that loads it.

    Each reference carries a hash of the file it points at. Pages serves
    everything with Cache-Control: max-age=600 and offers no way to change
    that, and a reload revalidates the page but not the scripts hanging off
    it -- so a reader who reloads after a deploy gets a fresh index.html
    pointing at the app.js his browser has been holding for ten minutes. A
    changed hash is a changed URL, which is a miss; an unchanged one still
    hits, so nothing is re-fetched for a build that changed nothing.

    Hashed rather than timestamped for that second half: a build id off the
    clock would put a new URL in index.html every run and show the file as
    modified in git with no change behind it.

    What this cannot reach is index.html itself. Arrive without reloading,
    within ten minutes of the last visit, and the page comes from cache with
    its old references -- stale, but stale as a matched set rather than a new
    page over an old script. Only a service worker fixes that, and this
    project has none.
    """
    stamps = {}
    for name in ("app.js", "style.css", "api-local.js"):
        src = os.path.join(STATIC, name)
        shutil.copy(src, os.path.join(DOCS, name))
        with open(src, "rb") as f:
            stamps[name] = hashlib.sha256(f.read()).hexdigest()[:8]
    html = open(os.path.join(STATIC, "index.html"), encoding="utf-8").read()
    if "api-local.js" not in html:
        html = html.replace('<script src="/app.js"></script>',
                            '<script src="api-local.js"></script>\n'
                            '<script src="app.js"></script>')
    # Pages serves from a subdirectory, so absolute asset paths would 404
    html = html.replace('href="/style.css"', 'href="style.css"')
    # After those rewrites, and quoted: "app.js" cannot match inside
    # "api-local.js", so the order of these does not matter.
    for name, stamp in stamps.items():
        ref = '"%s"' % name
        if ref not in html:
            raise SystemExit("build_site.py: index.html does not reference %s, so "
                             "the cache stamp would silently do nothing." % name)
        html = html.replace(ref, '"%s?v=%s"' % (name, stamp))
    open(os.path.join(DOCS, "index.html"), "w", encoding="utf-8").write(html)
    open(os.path.join(DOCS, ".nojekyll"), "w").close()

    # The play-by-play spec ships with the site so another front end can fetch
    # the contract rather than vendor a stale copy of it. It is the one part of
    # this app that a port has to reimplement instead of read.
    spec_src = os.path.join(BASE, "spec", "plays_english.json")
    if os.path.exists(spec_src):
        os.makedirs(os.path.join(DOCS, "spec"), exist_ok=True)
        shutil.copy(spec_src, os.path.join(DOCS, "spec", "plays_english.json"))
    print("  frontend copied, index.html rewritten for a subdirectory")
    print("  cache stamps %s" % ", ".join(
        "%s=%s" % (n, s) for n, s in sorted(stamps.items())))


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
    export_roles(conn)
    export_plays(conn)
    export_reference(conn)
    export_notable()

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
