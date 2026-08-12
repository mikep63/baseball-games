#!/usr/bin/env python3
"""Build retro.sqlite from the Retrosheet files in data/retrosheet.

Three layers, widest first:

  game        every game Retrosheet knows the result of  (1871-)
  bat/pit/fld one row per player per game                (1898-)
  box_event   the itemised HR, SB, CS, DP, TP, HBP        (1898-)

The game headers come from the game logs, which are the only source that
covers the nineteenth century. Everything below that comes from the box-score
event files, which start in 1898 but carry the per-player detail. Negro League
games are not in the game logs at all, so their headers are synthesised from
the box files instead — see load_boxes.

Usage: python3 build_db.py
"""
import csv
import glob
import json
import os
import re
import sqlite3
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data", "retrosheet")
DB_PATH = os.path.join(BASE, "retro.sqlite")

# The game logs spell the Kansas City Athletics OAK -- the franchise's modern
# code -- while the box scores, event files, rosters and TEAMyyyy directories
# all use the era code KC1. Every other club in every other era agrees between
# the two, so this is the entire difference rather than the first entry in a
# growing list. Left uncorrected it costs 1,029 games their box scores.
#
# Self-healing: check_team_fixes reports an entry that no longer changes
# anything, so a release that normalises this upstream leaves a dead line here
# that says so rather than silently rotting.
# Empty since the summer 2026 release, which is the release that fixed it: the
# Kansas City Athletics were OAK in the game logs and KC1 everywhere else from
# 1955 to 1967, and uncorrected it cost 1,029 games their box scores. All 2,060
# are KC1 upstream now. The mechanism stays for the next one, and
# check_team_fixes reports an entry as dead rather than letting it rot.
TEAM_CODE_FIXES = []

# Game-log files that aren't a regular season
SPECIAL_LOGS = {"glas": "allstar", "glws": "worldseries", "gllc": "lcs",
                "gldv": "division", "glwc": "wildcard"}

OFF = ["ab", "h", "d", "t", "hr", "rbi", "sh", "sf", "hbp", "bb", "ibb",
       "so", "sb", "cs", "gidp", "ci", "lob"]            # 17, game-log order
PITCH = ["pitchers", "iher", "ter", "wp", "bk"]          # 5
DEF = ["po", "a", "e", "pb", "dp", "tp"]                 # 6
TEAM_STATS = OFF + PITCH + DEF                           # 28 per side

SCHEMA = """
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;

CREATE TABLE person(
  id TEXT PRIMARY KEY, last TEXT, first TEXT, nickname TEXT,
  bats TEXT, throws TEXT, height INT, weight INT,
  birthdate TEXT, birth_city TEXT, birth_state TEXT, birth_country TEXT,
  deathdate TEXT, death_city TEXT, death_state TEXT, death_country TEXT,
  play_debut TEXT, play_last TEXT, mgr_debut TEXT, mgr_last TEXT,
  coach_debut TEXT, coach_last TEXT, ump_debut TEXT, ump_last TEXT,
  birth_name TEXT, hof TEXT);

CREATE TABLE franchise(
  id TEXT PRIMARY KEY, league TEXT, city TEXT, nickname TEXT,
  first INT, last INT);

CREATE TABLE team(
  id TEXT, season INT, league TEXT, city TEXT, nickname TEXT,
  PRIMARY KEY(id, season));

CREATE TABLE park(
  id TEXT PRIMARY KEY, name TEXT, aka TEXT, city TEXT, state TEXT,
  start TEXT, "end" TEXT, league TEXT, notes TEXT);

CREATE TABLE roster(
  team TEXT, season INT, person TEXT, bats TEXT, throws TEXT, pos TEXT);

CREATE TABLE game(
  id TEXT PRIMARY KEY, date TEXT, number TEXT, dow TEXT,
  season INT, gametype TEXT, league TEXT,
  vis TEXT, vis_lg TEXT, vis_gnum INT, vis_score INT,
  home TEXT, home_lg TEXT, home_gnum INT, home_score INT,
  outs INT, daynight TEXT, completion TEXT, forfeit TEXT, protest TEXT,
  park TEXT, attendance INT, duration INT,
  vis_line TEXT, home_line TEXT,
  ump_hp TEXT, ump_1b TEXT, ump_2b TEXT, ump_3b TEXT, ump_lf TEXT, ump_rf TEXT,
  mgr_vis TEXT, mgr_home TEXT,
  wp TEXT, lp TEXT, sv TEXT, gwrbi TEXT, vis_sp TEXT, home_sp TEXT,
  info TEXT, acquisition TEXT,
  temp INT, wind_dir TEXT, wind_speed INT, sky TEXT, precip TEXT, field_cond TEXT,
  start_time TEXT, has_box INT DEFAULT 0, has_pbp INT DEFAULT 0,
  %s);

CREATE TABLE game_start(
  game TEXT, side INT, slot INT, person TEXT, pos INT);

-- One row per player per game: his whole batting line, however he got into
-- the game. A pinch-hitter is here too -- Retrosheet's phline does not add to
-- this, it annotates it (see pinch_hit), and summing the two double-counts
-- every pinch-hit appearance in the file.
CREATE TABLE bat(
  game TEXT, person TEXT, side INT, slot INT, seq INT,
  ab INT, r INT, h INT, d INT, t INT, hr INT, rbi INT, sh INT, sf INT,
  hbp INT, bb INT, ibb INT, so INT, sb INT, cs INT, gidp INT, intf INT);

-- The pinch-hitting appearance itself: which inning, and what he did in it.
-- These stats are already counted in bat -- this table says when.
CREATE TABLE pinch_hit(
  game TEXT, person TEXT, side INT, inning INT,
  ab INT, r INT, h INT, d INT, t INT, hr INT, rbi INT, sh INT, sf INT,
  hbp INT, bb INT, ibb INT, so INT, sb INT, cs INT, gidp INT, intf INT);

CREATE TABLE pinch_run(
  game TEXT, person TEXT, side INT, inning INT, r INT, sb INT, cs INT);

CREATE TABLE pit(
  game TEXT, person TEXT, side INT, seq INT,
  outs INT, noout INT, bfp INT, h INT, d INT, t INT, hr INT, r INT, er INT,
  bb INT, ibb INT, so INT, hbp INT, wp INT, bk INT, sh INT, sf INT);

CREATE TABLE fld(
  game TEXT, person TEXT, side INT, seq INT, pos INT,
  outs INT, po INT, a INT, e INT, dp INT, tp INT, pb INT);

CREATE TABLE team_box(
  game TEXT, side INT, lob INT, er INT, dp INT, tp INT);

CREATE TABLE box_event(
  game TEXT, kind TEXT, side INT, players TEXT,
  inning INT, runners_on INT, outs INT);

CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
""" % ",\n  ".join("%s_%s INT" % (s, c) for s in ("v", "h") for c in TEAM_STATS)

INDEXES = """
CREATE INDEX ix_game_date    ON game(date);
CREATE INDEX ix_game_season  ON game(season);
CREATE INDEX ix_game_vis     ON game(vis, season);
CREATE INDEX ix_game_home    ON game(home, season);
CREATE INDEX ix_game_park    ON game(park);
CREATE INDEX ix_start_game   ON game_start(game);
CREATE INDEX ix_start_person ON game_start(person);
CREATE INDEX ix_bat_game     ON bat(game);
CREATE INDEX ix_bat_person   ON bat(person);
CREATE INDEX ix_pit_game     ON pit(game);
CREATE INDEX ix_pit_person   ON pit(person);
CREATE INDEX ix_fld_game     ON fld(game);
CREATE INDEX ix_fld_person   ON fld(person);
CREATE INDEX ix_run_game     ON pinch_run(game);
CREATE INDEX ix_run_person   ON pinch_run(person);
CREATE INDEX ix_ph_game      ON pinch_hit(game);
CREATE INDEX ix_ph_person    ON pinch_hit(person);
CREATE INDEX ix_tbox_game    ON team_box(game);
CREATE INDEX ix_bev_game     ON box_event(game);
CREATE INDEX ix_roster_team  ON roster(team, season);
CREATE INDEX ix_roster_person ON roster(person);
"""


# ------------------------------------------------------------------ helpers

def num(x):
    """Retrosheet leaves a stat blank when it isn't known; that is not a zero."""
    x = (x or "").strip()
    if not x or x == "?":
        return None
    try:
        return int(x)
    except ValueError:
        return None


def stat(x):
    """A counting stat, where Retrosheet writes a negative for "not recorded".

    Sacrifice flies before 1954, intentional walks before 1955, caught
    stealing and GIDP in the early years -- none of these were kept, and the
    files say so with a negative rather than a blank. Stored as-is they don't
    just read wrong, they subtract: SUM() over a career quietly takes runs off
    the total. 12,377 game rows and roughly 200,000 box lines are affected,
    all of them before 1910.
    """
    n = num(x)
    return None if n is not None and n < 0 else n


def text(x):
    x = (x or "").strip()
    return x or None


def iso(d):
    """MM/DD/YYYY or YYYY/MM/DD -> YYYY-MM-DD, tolerating partial dates."""
    d = (d or "").strip()
    if not d:
        return None
    if "/" not in d:
        return d
    p = d.split("/")
    if len(p[0]) == 4:
        y, m, day = p[0], p[1] if len(p) > 1 else "", p[2] if len(p) > 2 else ""
    else:
        m, day, y = p[0], p[1] if len(p) > 1 else "", p[2] if len(p) > 2 else ""
    if not y:
        return None
    return "%s-%s-%s" % (y, (m or "00").zfill(2), (day or "00").zfill(2))


def line_score(s):
    """Normalise a line score to comma-separated innings.

    The game logs write one character per inning with parentheses round any
    double-digit inning and "x" for a home ninth that wasn't needed --
    "010000(10)0x". The box files already use commas. Storing both shapes and
    sorting it out in the frontend twice over is how the two front ends drift
    apart, so everything is converted here.
    """
    s = (s or "").strip()
    if not s:
        return None
    if "," in s:
        return s
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c == "(":
            j = s.find(")", i)
            if j == -1:
                break
            out.append(s[i + 1:j])
            i = j + 1
        elif c in "xX":
            out.append("x")
            i += 1
        else:
            out.append(c)
            i += 1
    return ",".join(out)


def height_in(h):
    """Retrosheet writes height as feet-inches, e.g. 6-05."""
    h = (h or "").strip()
    m = re.match(r"^(\d+)-(\d+)$", h)
    if not m:
        return None
    return int(m.group(1)) * 12 + int(m.group(2))


def fix_team(code, season):
    for wrong, right, y0, y1 in TEAM_CODE_FIXES:
        if code == wrong and y0 <= season <= y1:
            return right
    return code


def read_csv(path):
    with open(path, newline="", encoding="latin-1") as f:
        for row in csv.DictReader(f):
            yield row


def rel(path):
    return os.path.join(DATA, path)


def say(label, n, extra=""):
    print("  %-22s %9s  %s" % (label, "{:,}".format(n), extra))


# ------------------------------------------------------------- static tables

def load_people(conn):
    rows = []
    for r in read_csv(rel("biodata/biofile.csv")):
        rows.append((
            r["PLAYERID"], text(r["LAST"]), text(r["FIRST"]), text(r["NICKNAME"]),
            text(r["BATS"]), text(r["THROWS"]), height_in(r["HEIGHT"]), num(r["WEIGHT"]),
            iso(r["BIRTHDATE"]), text(r["BIRTH.CITY"]), text(r["BIRTH.STATE"]),
            text(r["BIRTH.COUNTRY"]),
            iso(r["DEATHDATE"]), text(r["DEATH.CITY"]), text(r["DEATH.STATE"]),
            text(r["DEATH.COUNTRY"]),
            iso(r["PLAY.DEBUT"]), iso(r["PLAY.LASTGAME"]),
            iso(r["MGR.DEBUT"]), iso(r["MGR.LASTGAME"]),
            iso(r["COACH.DEBUT"]), iso(r["COACH.LASTGAME"]),
            iso(r["UMP.DEBUT"]), iso(r["UMP.LASTGAME"]),
            text(r["BIRTH.NAME"]), text(r["HOF"])))
    conn.executemany("INSERT OR REPLACE INTO person VALUES(%s)" % ",".join("?" * 26), rows)
    say("person", len(rows))


def load_franchises(conn):
    rows = [(r["TEAM"], text(r["LEAGUE"]), text(r["CITY"]), text(r["NICKNAME"]),
             num(r["FIRST"]), num(r["LAST"])) for r in read_csv(rel("biodata/teams.csv"))]
    conn.executemany("INSERT OR REPLACE INTO franchise VALUES(?,?,?,?,?,?)", rows)
    say("franchise", len(rows))


# Retrosheet spells the two major leagues "AL"/"NL" up to 1949 and "A"/"N"
# from 1950. Nothing else changes, but a page grouped by league is headed
# differently either side of that line for no reason the reader can see.
LEAGUE_SPELLINGS = {"A": "AL", "N": "NL"}

# A squad's league is not in doubt: the National League All-Stars are in the
# National League. Retrosheet files them under the American in TEAM1997 and
# TEAM2025 -- 2 of the 90 seasons the squad appears, against 73 filed
# correctly -- which drops the NL side into the middle of the AL list.
ALLSTAR_LEAGUE = {"ALS": "AL", "NLS": "NL"}


def load_teams(conn):
    rows = []
    corrected = 0
    for path in sorted(glob.glob(rel("teams/TEAM[0-9][0-9][0-9][0-9]"))):
        season = int(re.search(r"(\d{4})$", path).group(1))
        with open(path, newline="", encoding="latin-1") as f:
            for r in csv.reader(f):
                if len(r) < 4:
                    continue
                league = LEAGUE_SPELLINGS.get(text(r[1]), text(r[1]))
                right = ALLSTAR_LEAGUE.get(r[0])
                if right and league != right:
                    league = right
                    corrected += 1
                rows.append((r[0], season, league, text(r[2]), text(r[3])))
    conn.executemany("INSERT OR REPLACE INTO team VALUES(?,?,?,?,?)", rows)
    say("team season", len(rows))
    if corrected:
        say("league corrected", corrected, "All-Star squads filed under the wrong league")
    return corrected


def load_parks(conn):
    """Ballparks, with the name field split where it holds more than one.

    One row -- Chicago's CHI12 -- carries two current names separated by a
    semicolon, so a page renders "Guaranteed Rate Field;U.S. Cellular Field".
    The first is the name; the others belong with the former names in AKA.
    Harmless where there is no semicolon, so it needs no special case and
    stops applying by itself if the source is tidied.
    """
    rows = []
    for r in read_csv(rel("biodata/ballparks.csv")):
        names = [x.strip() for x in (r["NAME"] or "").split(";") if x.strip()]
        aka = [x.strip() for x in (r["AKA"] or "").split(";") if x.strip()]
        rows.append((r["PARKID"], names[0] if names else None,
                     "; ".join(names[1:] + aka) or None, text(r["CITY"]),
                     text(r["STATE"]), text(r["START"]), text(r["END"]),
                     text(r["LEAGUE"]), text(r["NOTES"])))
    conn.executemany("INSERT OR REPLACE INTO park VALUES(?,?,?,?,?,?,?,?,?)", rows)
    say("park", len(rows))


def load_rosters(conn):
    rows = []
    for path in glob.glob(rel("rosters/*.ROS")):
        m = re.match(r"^([A-Z0-9]{3})(\d{4})\.ROS$", os.path.basename(path))
        if not m:
            continue
        team, season = m.group(1), int(m.group(2))
        with open(path, newline="", encoding="latin-1") as f:
            for r in csv.reader(f):
                if len(r) < 7:
                    continue
                rows.append((team, season, r[0], text(r[3]), text(r[4]), text(r[6])))
    conn.executemany("INSERT INTO roster VALUES(?,?,?,?,?,?)", rows)
    say("roster line", len(rows))


# ------------------------------------------------------------------ game logs

GAME_COLS = ("id,date,number,dow,season,gametype,league,"
             "vis,vis_lg,vis_gnum,vis_score,home,home_lg,home_gnum,home_score,"
             "outs,daynight,completion,forfeit,protest,park,attendance,duration,"
             "vis_line,home_line,ump_hp,ump_1b,ump_2b,ump_3b,ump_lf,ump_rf,"
             "mgr_vis,mgr_home,wp,lp,sv,gwrbi,vis_sp,home_sp,info,acquisition,"
             + ",".join("%s_%s" % (s, c) for s in ("v", "h") for c in TEAM_STATS))


def load_gamelogs(conn):
    rows, starts = [], []
    fixed = {f: 0 for f in TEAM_CODE_FIXES}
    unknown = []
    for path in sorted(glob.glob(rel("gamelogs/gl*.txt"))):
        stem = os.path.basename(path)[:-4]
        # A stem that is neither gl<year> nor a known special log falls through
        # to "regular", which would file a postseason series into the regular
        # season without a word. Retrosheet adds these -- the 1900
        # Chronicle-Telegraph Cup arrived in the summer 2026 release -- so the
        # fall-through is reported rather than trusted.
        if stem not in SPECIAL_LOGS and not re.fullmatch(r"gl\d{4}", stem):
            unknown.append(stem)
        gametype = SPECIAL_LOGS.get(stem, "regular")
        with open(path, newline="", encoding="latin-1") as f:
            for r in csv.reader(f):
                if len(r) < 161:
                    continue
                date = r[0]
                season = int(date[:4])
                number = r[1] or "0"
                vis, home = r[3], r[6]
                for fx in TEAM_CODE_FIXES:
                    if vis == fx[0] and fx[2] <= season <= fx[3]:
                        vis = fx[1]; fixed[fx] += 1
                    if home == fx[0] and fx[2] <= season <= fx[3]:
                        home = fx[1]; fixed[fx] += 1
                gid = home + date + number
                league = r[7] if r[4] == r[7] else None
                off = [stat(x) for x in r[21:49]] + [stat(x) for x in r[49:77]]
                rows.append((
                    gid, "%s-%s-%s" % (date[:4], date[4:6], date[6:8]), number, r[2],
                    season, gametype, league,
                    vis, text(r[4]), num(r[5]), num(r[9]),
                    home, text(r[7]), num(r[8]), num(r[10]),
                    num(r[11]), text(r[12]), text(r[13]), text(r[14]), text(r[15]),
                    text(r[16]), num(r[17]), num(r[18]),
                    line_score(r[19]), line_score(r[20]),
                    text(r[77]), text(r[79]), text(r[81]), text(r[83]),
                    text(r[85]), text(r[87]),
                    text(r[89]), text(r[91]),
                    text(r[93]), text(r[95]), text(r[97]), text(r[99]),
                    text(r[101]), text(r[103]),
                    text(r[159]), text(r[160])) + tuple(off))
                for side, base in ((0, 105), (1, 132)):
                    for slot in range(9):
                        i = base + slot * 3
                        pid = text(r[i])
                        if pid:
                            starts.append((gid, side, slot + 1, pid, num(r[i + 2])))
    conn.executemany("INSERT OR REPLACE INTO game(%s) VALUES(%s)"
                     % (GAME_COLS, ",".join("?" * len(GAME_COLS.split(",")))), rows)
    conn.executemany("INSERT INTO game_start VALUES(?,?,?,?,?)", starts)
    say("game (from logs)", len(rows))
    say("starting lineup", len(starts))
    return fixed, unknown


# -------------------------------------------------------------- box scores

BOX_SOURCES = [("boxes/*.EB[AN]", None),          # AL/NL regular season, 1897-
                ("ebe/*.EBE", "postseason"),      # All-Star and post-season
                ("ngl_b/*.EBR", "negro")]         # Negro Leagues

# The kind above is only used for a game the game logs never listed. Every
# World Series and All-Star game is in a log of its own and keeps the type that
# log gives it; what falls through is a series the logs don't carry, and the
# only ones are postseason. Left as None these arrived as regular season -- the
# 1900 Chronicle-Telegraph Cup, four games in the summer 2026 release, filed
# into Pittsburgh's and Brooklyn's regular seasons without a word.


def load_boxes(conn, known):
    """Read every box-score event file.

    `known` is the set of game ids the game logs already gave us a header for.
    Anything outside it -- which in practice means the Negro Leagues, whose
    games the game logs do not cover at all -- gets a header synthesised from
    the file's own info records, so those games are searchable alongside the
    rest instead of existing only as orphaned stat lines.
    """
    bat, ph, run, pit, fld, tbox, bev, headers = [], [], [], [], [], [], [], []
    weather = []
    seen, synth = set(), 0
    total = {"bat": 0, "ph": 0, "run": 0, "pit": 0, "fld": 0, "tbox": 0, "bev": 0}

    def flush():
        """Write and clear after each file.

        Holding all 5.5M batting and 5.1M fielding lines as Python tuples
        before the first insert costs several GB; a season at a time costs
        nothing worth measuring.
        """
        for name, sql, rows in (
                ("bat", "INSERT INTO bat VALUES(%s)" % ",".join("?" * 22), bat),
                ("ph", "INSERT INTO pinch_hit VALUES(%s)" % ",".join("?" * 21), ph),
                ("run", "INSERT INTO pinch_run VALUES(?,?,?,?,?,?,?)", run),
                ("pit", "INSERT INTO pit VALUES(%s)" % ",".join("?" * 21), pit),
                ("fld", "INSERT INTO fld VALUES(%s)" % ",".join("?" * 12), fld),
                ("tbox", "INSERT INTO team_box VALUES(?,?,?,?,?,?)", tbox),
                ("bev", "INSERT INTO box_event VALUES(?,?,?,?,?,?,?)", bev)):
            if rows:
                conn.executemany(sql, rows)
                total[name] += len(rows)
                del rows[:]

    for pattern, kind in BOX_SOURCES:
        for path in sorted(glob.glob(rel(pattern))):
            gid, info, lines = None, {}, {}
            for raw in open(path, encoding="latin-1", errors="replace"):
                p = raw.rstrip("\n").split(",")
                t = p[0]
                if t == "id":
                    if gid:
                        if gid not in known:
                            headers.append(_synth_header(gid, info, lines, kind))
                        else:
                            weather.append(_weather(gid, info))
                    gid, info, lines = p[1], {}, {}
                    seen.add(gid)
                elif t == "info" and len(p) >= 3:
                    info[p[1]] = ",".join(p[2:]).strip()
                elif t == "line":
                    lines[num(p[1])] = ",".join(p[2:]).strip()
                elif t == "stat":
                    k = p[1]
                    if k == "bline" and len(p) >= 23:
                        bat.append((gid, p[2], num(p[3]), num(p[4]), num(p[5]))
                                   + tuple(stat(x) for x in p[6:23]))
                    elif k == "phline" and len(p) >= 22:
                        ph.append((gid, p[2], num(p[4]), num(p[3]))
                                  + tuple(stat(x) for x in p[5:22]))
                    elif k == "prline" and len(p) >= 7:
                        run.append((gid, p[2], num(p[4]), num(p[3]),
                                    stat(p[5]), stat(p[6]),
                                    stat(p[7]) if len(p) > 7 else None))
                    elif k == "pline" and len(p) >= 22:
                        pit.append((gid, p[2], num(p[3]), num(p[4]))
                                   + tuple(stat(x) for x in p[5:22]))
                    elif k == "dline" and len(p) >= 13:
                        fld.append((gid, p[2], num(p[3]), num(p[4]), num(p[5]))
                                   + tuple(stat(x) for x in p[6:13]))
                    elif k == "tline" and len(p) >= 7:
                        tbox.append((gid, num(p[2]), stat(p[3]), stat(p[4]),
                                     stat(p[5]), stat(p[6])))
                elif t == "event":
                    k = p[1][:-4] if p[1].endswith("line") else p[1]
                    side = num(p[2])
                    if k == "hr" and len(p) >= 8:
                        bev.append((gid, "hr", side, ",".join(p[3:5]),
                                    num(p[5]), num(p[6]), num(p[7])))
                    elif k in ("sb", "cs") and len(p) >= 7:
                        bev.append((gid, k, side, ",".join(p[3:6]), num(p[6]), None, None))
                    else:
                        bev.append((gid, k, side, ",".join(x for x in p[3:] if x),
                                    None, None, None))
            if gid:
                if gid not in known:
                    headers.append(_synth_header(gid, info, lines, kind))
                else:
                    weather.append(_weather(gid, info))
            flush()

    synth = len(headers)
    if headers:
        cols = ("id,date,number,season,gametype,league,vis,vis_lg,home,home_lg,"
                "vis_score,home_score,park,attendance,duration,daynight,"
                "vis_line,home_line,ump_hp,ump_1b,ump_2b,ump_3b,wp,lp,sv,"
                "temp,wind_dir,wind_speed,sky,precip,field_cond,start_time")
        conn.executemany("INSERT OR REPLACE INTO game(%s) VALUES(%s)"
                         % (cols, ",".join("?" * len(cols.split(",")))), headers)

    say("batting line", total["bat"])
    say("pinch-hit line", total["ph"], "annotates bat, does not add to it")
    say("pinch-run line", total["run"])
    say("pitching line", total["pit"])
    say("fielding line", total["fld"])
    say("team box line", total["tbox"])
    say("box event", total["bev"])
    say("game (from boxes)", synth, "headers the logs don't carry")

    # Weather, sky, wind and first pitch are in the box files and in nothing
    # else -- the game logs have no column for any of them. Without this the
    # game page's Weather line is empty for every game that has a game-log
    # header, which is all but the Negro Leagues.
    weather = [w for w in weather if any(v is not None for v in w[:-1])]
    conn.executemany("""UPDATE game SET temp = COALESCE(temp, ?),
                        sky = COALESCE(sky, ?), precip = COALESCE(precip, ?),
                        field_cond = COALESCE(field_cond, ?),
                        wind_dir = COALESCE(wind_dir, ?),
                        wind_speed = COALESCE(wind_speed, ?),
                        start_time = COALESCE(start_time, ?)
                        WHERE id = ?""", weather)
    say("weather backfilled", len(weather), "from the box files")
    return seen


UNKNOWN = {"unknown", "none", "", "0:00pm", "(none)"}


def _weather(gid, info):
    """Conditions for a game whose header came from the game log.

    Retrosheet spells "we don't know" several ways depending on the field --
    the string "unknown", a zero temperature, a wind speed of -1 -- and all of
    them render as data if taken literally. A 0F first pitch in July is not a
    cold snap, it is a blank.
    """
    def word(k):
        v = (info.get(k) or "").strip()
        return None if v.lower() in UNKNOWN else v
    temp = stat(info.get("temp"))
    return (temp or None, word("sky"), word("precip"), word("fieldcond"),
            word("winddir"), stat(info.get("windspeed")), word("starttime"), gid)


def _synth_header(gid, info, lines, kind):
    """A game row for a game the game logs never listed (the Negro Leagues)."""
    date = iso(info.get("date"))
    season = int(date[:4]) if date else None
    vs, hs = None, None
    for side, s in ((0, lines.get(0)), (1, lines.get(1))):
        if s:
            total = sum(int(x) for x in s.split(",") if x.strip().lstrip("-").isdigit())
            if side == 0:
                vs = total
            else:
                hs = total
    return (gid, date, info.get("number") or "0", season,
            kind or "regular", None,
            info.get("visteam"), None, info.get("hometeam"), None,
            vs, hs, info.get("site"), num(info.get("attendance")),
            num(info.get("timeofgame")), info.get("daynight"),
            lines.get(0), lines.get(1),
            info.get("umphome"), info.get("ump1b"), info.get("ump2b"),
            info.get("ump3b"), info.get("wp"), info.get("lp"), info.get("save"),
            stat(info.get("temp")) or None, info.get("winddir"), stat(info.get("windspeed")),
            info.get("sky"), info.get("precip"), info.get("fieldcond"),
            info.get("starttime"))


def mark_coverage(conn, box_ids):
    """Flag which games have a box score and which have play-by-play."""
    pbp = set()
    for pattern in ("events/*.EV[AN]", "events/*.ED[AN]",
                    "postseason/*.EVE", "allstar/*.EVE", "ngl_e/*.EVR"):
        for path in glob.glob(rel(pattern)):
            with open(path, encoding="latin-1", errors="replace") as f:
                for line in f:
                    if line.startswith("id,"):
                        pbp.add(line.strip().split(",")[1])
    conn.executemany("UPDATE game SET has_box = 1 WHERE id = ?",
                     [(g,) for g in box_ids])
    conn.executemany("UPDATE game SET has_pbp = 1 WHERE id = ?", [(g,) for g in pbp])
    say("with box score", len(box_ids))
    say("with play-by-play", len(pbp))
    return pbp


RELEASE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "release.json")


def fingerprint(conn):
    """The numbers a release is judged by, in one small committed file.

    Retrosheet ships one archive a year or two and says in prose what changed.
    This is the same claim in figures, taken from the build itself: what the
    next build prints as moved is what actually moved, and `git diff
    release.json` is the release's record in the history for good.
    """
    q = lambda sql: conn.execute(sql).fetchall()
    one_ = lambda sql: conn.execute(sql).fetchone()[0]
    return {
        "seasons": {"first": one_("SELECT MIN(season) FROM game"),
                    "last": one_("SELECT MAX(season) FROM game")},
        "games": one_("SELECT COUNT(*) FROM game"),
        "withBox": one_("SELECT COUNT(*) FROM game WHERE has_box = 1"),
        "withPlays": one_("SELECT COUNT(*) FROM game WHERE has_pbp = 1"),
        # The first season each kind of record appears at all -- not the same
        # claim as the README's "complete from", but the number that moves when
        # a release reaches further back, which is what a release note promises
        # and this is here to check.
        "firstBoxSeason": one_("SELECT MIN(season) FROM game WHERE has_box = 1"),
        "firstPlaySeason": one_("SELECT MIN(season) FROM game WHERE has_pbp = 1"),
        "firstBattingSeason": one_("SELECT MIN(g.season) FROM bat b "
                                   "JOIN game g ON g.id = b.game"),
        "gametypes": {k: v for k, v in q(
            "SELECT gametype, COUNT(*) FROM game GROUP BY gametype ORDER BY 1")},
        "people": one_("SELECT COUNT(*) FROM person"),
        "rows": {t: one_("SELECT COUNT(*) FROM %s" % t)
                 for t in ("bat", "pit", "fld", "pinch_hit", "pinch_run",
                           "box_event", "game_start", "roster")},
    }


def report_release(conn):
    """Print what moved since the committed fingerprint, then rewrite it."""
    new = fingerprint(conn)
    old = None
    if os.path.exists(RELEASE_PATH):
        with open(RELEASE_PATH) as f:
            old = json.load(f)

    def walk(a, b, path=""):
        out = []
        for k in sorted(set(a) | set(b)):
            av, bv = a.get(k), b.get(k)
            where = "%s.%s" % (path, k) if path else k
            if isinstance(av, dict) or isinstance(bv, dict):
                out += walk(av or {}, bv or {}, where)
            elif av != bv:
                delta = ("  (%+d)" % (bv - av)
                         if isinstance(av, int) and isinstance(bv, int) else "")
                out.append("  %-28s %s -> %s%s" % (where, av, bv, delta))
        return out

    if old is None:
        print("\nNo release.json yet -- writing the first fingerprint.")
    else:
        moved = walk(old, new)
        print("\nSince the last release:")
        if moved:
            print("\n".join(moved))
        else:
            print("  nothing moved.")
    with open(RELEASE_PATH, "w") as f:
        json.dump(new, f, indent=2, sort_keys=True)
        f.write("\n")


def check_team_fixes(conn, fixed, box_ids):
    """Report on TEAM_CODE_FIXES so it can't rot in silence."""
    problems = []
    for fx in TEAM_CODE_FIXES:
        if not fixed.get(fx):
            problems.append("  TEAM_CODE_FIXES entry %s is dead -- the game logs no "
                            "longer use %s in %d-%d. Remove it." % (fx, fx[0], fx[2], fx[3]))
    have = {r[0] for r in conn.execute("SELECT id FROM game")}
    orphan = box_ids - have
    if orphan:
        sample = ", ".join(sorted(orphan)[:5])
        problems.append("  %d box scores have no game row (e.g. %s). A team code or "
                        "game-number rule has changed." % (len(orphan), sample))
    return problems


def main():
    if not os.path.isdir(DATA):
        sys.exit("No data at %s -- run update_data.py first." % DATA)
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)

    print("Reference data")
    load_people(conn)
    load_franchises(conn)
    league_fixes = load_teams(conn)
    load_parks(conn)
    load_rosters(conn)

    print("Games")
    fixed, unknown_logs = load_gamelogs(conn)
    known = {r[0] for r in conn.execute("SELECT id FROM game")}

    print("Box scores")
    box_ids = load_boxes(conn, known)

    print("Coverage")
    mark_coverage(conn, box_ids)

    problems = check_team_fixes(conn, fixed, box_ids)
    for stem in unknown_logs:
        problems.append("  gamelogs/%s.txt is not gl<year> and not in SPECIAL_LOGS, so "
                        "its games were filed as regular season. If it is a round, add "
                        "it to SPECIAL_LOGS." % stem)
    if not league_fixes:
        problems.append("  ALLSTAR_LEAGUE no longer changes anything -- Retrosheet has "
                        "fixed the All-Star squads' leagues upstream. Remove it.")

    print("Indexing ...")
    conn.executescript(INDEXES)
    seasons = conn.execute("SELECT MIN(season), MAX(season), COUNT(*) FROM game").fetchone()
    conn.executemany("INSERT OR REPLACE INTO meta VALUES(?,?)",
                     [("first_season", str(seasons[0])), ("last_season", str(seasons[1])),
                      ("games", str(seasons[2]))])
    conn.commit()

    print("\n%s  %.0f MB" % (DB_PATH, os.path.getsize(DB_PATH) / 1e6))
    print("%s games, %s-%s" % ("{:,}".format(seasons[2]), seasons[0], seasons[1]))
    # Read before the VACUUM, which is the last thing done to the file.
    report_release(conn)
    conn.execute("VACUUM")
    conn.close()

    if problems:
        print("\nNeeds attention:")
        for p in problems:
            print(p)


if __name__ == "__main__":
    main()
