# Baseball Games

A zero-dependency local web app over the [Retrosheet](https://www.retrosheet.org)
game and box-score files: **240,265 games, 1871–2025**, of which 221,408 have a
full box score. Python standard library only — no pip installs.

It is the sibling of `baseball-records`, which does the same job over the
Lahman database. That one answers *what did he do in 1927*; this one answers
*what did he do on the 12th of August* — and, for a reader who has no date in
mind, the Notable tab answers *show me something worth reading*: the
no-hitters, perfect games, cycles and four-home-run games, derived from these
box scores rather than copied from anyone's list. **A change to one front end is not
finished until the other has it** — and the iOS port, `baseball-games-ios`,
counts as a front end.

## Quick start

```sh
python3 update_data.py     # fetch Retrosheet (~340 MB) and build the database
python3 app.py             # serves http://127.0.0.1:8000
```

`update_data.py` calls `build_db.py` when it finishes, so the first run does
everything. After that, `python3 build_db.py` alone rebuilds in about 80
seconds.

Neither `data/` nor `retro.sqlite` is committed: 2.1 GB and 1.6 GB
respectively, both entirely derived, both one command away.

## What's in it

| | |
|---|---|
| **Games** | every game, filterable by season, league, club, park, date and type |
| **Game** | line score, both box scores, itemised HR/SB/CS/DP/HBP, umpires, weather, attendance, and every play |
| **Player** | bio, season-by-season batting/pitching/fielding/managing/umpiring — one table per kind of game — and every game he took part in |
| **Team** | a club's season: schedule, running record, roster |
| **Park** | where it was, what was played there, attendance by season |

## GitHub Pages

`docs/` is a self-contained build of the same app with no server: `api-local.js`
reimplements every endpoint in the browser over exported JSON, so `app.js` runs
unchanged and there is one frontend rather than two.

```sh
python3 build_site.py                      # writes docs/
python3 -m http.server -d docs 8001        # preview
```

Then **Settings → Pages → Deploy from a branch → `main`, folder `/docs`**.

The exports are columnar — one shared list of column names, then rows as bare
arrays — and sharded by season, because that is how the app is used. A visitor
looking at 1927 downloads one 1.6 MB file, not the corpus. Careers are sharded
on the player's initial for the same reason: one file is 18 MB and every player
page would pay for it.

`docs/` is about 639 MB and **is committed**, which is the cost of serverless
hosting. Most shards are byte-identical between releases, so the yearly growth
is the seasons that actually changed rather than another full copy.

The play-by-play is the one thing written compressed. **GitHub Pages caps a
published site at 1 GB**, and 18.3 million plays are 889 MB of plain JSON —
more than the whole of the rest of the site. Gzipped they are 115 MB across
2,982 shards, one per club per season, the largest 60 KB. It buys nothing on
download —
Pages serves everything gzipped in transit anyway — and everything on fitting.
The cost is that reading them needs `DecompressionStream`, so a browser older
than Safari 16.4, Firefox 113 or Chrome 80 is told so and shown the rest of the
page; and that `test_views.sh` inflates the shards the parity test reads,
because JavaScriptCore has no `DecompressionStream` either.

## Layout

| | |
|---|---|
| `update_data.py` | fetch and verify a Retrosheet release |
| `build_db.py` | parse it into `retro.sqlite` |
| `app.py` | the server and the JSON API — **the reference implementation** |
| `build_site.py` | export `docs/` for Pages |
| `static/` | the frontend: `index.html`, `app.js`, `style.css`, `api-local.js` |
| `test_views.sh` | re-record fixtures, render every view, check both backends agree |

## What the data can and can't say

Worth knowing before trusting a number:

- **Results go back to 1871, batting lines only to 1897.** The game logs for
  1871–1896 carry the score and nothing else — no team batting totals, let
  alone per-player ones. 26 seasons, 17,601 games. The 1897 National League
  arrived with the summer 2026 release; 1896 is still the wall.
- **Play-by-play is complete for the AL and NL from 1908**, which is earlier
  than Retrosheet's reputation suggests — 1908 and 1909 arrived complete with
  the summer 2026 release. Four seasons are one game short. The Federal League
  of 1914–15 is the whole of the apparent gap in those years.
- **The Federal League of 1914–15 has no box scores at all.** Its 1,243 games
  carry the game log's result and team totals and not one player line — no
  batting, pitching or fielding rows, and no play-by-play either. A career
  runs straight through it: Benny Kauff led the league in both its seasons,
  and his page goes 1912, then 1916.
- **Pitch sequences effectively start in 1988** (~88% of plays since; near zero
  before), and they are not kept here. They record what happened to each pitch
  — ball, called strike, foul, in play — and never what was thrown: Retrosheet
  has no pitch types, velocities or locations at all. That is two fifths of the
  play-by-play bytes for the shape of a plate appearance rather than its
  result, so `build_db.py` reads past them.
- **The play-by-play is stored in Retrosheet's shorthand and expanded where it
  is read.** "S8/L.2-H" is eight bytes; its English is ninety, and there are
  18,263,689 of them. Expanding is a pure function of the string, so nothing
  expanded is ever stored — `describePlay` in `app.js` does it at the moment of
  reading. It handles 100% of a 232,535-play sample, and anything it does not
  recognise is shown as shorthand rather than as a confidently wrong sentence.
- **Hit locations start in 1989.** They are written inside the trajectory
  modifier — `F78XD` is an extra-deep fly to left-centre — and Retrosheet
  documents the zones only in a diagram, `hitloc.jpg`, so `locationPhrase` in
  `app.js` reads a grammar taken off the data: 95 codes over 17 zones, a side,
  a depth and a foul flag. From 1989 about 97% of batted balls carry one.
  Before 1988 it is erratic rather than absent — 26% in 1985, 2.4% in 1950,
  24% in 1925 — which is why the About page says so on the page rather than
  letting an old game look broken.
- **A substitution names the man arriving and no one else.** Retrosheet holds
  the place of a change with an `NP` play — "no play" — and names the man in
  the `sub` record after it; 1,787,561 of them are loaded, keyed to the play
  they follow, because the file's own order is the only thing placing them in
  the game. Who left is not in the record. Deducing him would mean replaying
  the lineup and every change before it to see who held the slot, which goes
  quietly wrong on double switches, so the page does not claim it. 14% of subs
  are men already in the game moving across, which is why a fielder "takes
  over" rather than "comes in".
- **Negro League games are not in the game logs at all.** Their headers here are
  synthesised from the box-score files, and Retrosheet notes most were deduced
  from newspaper accounts.
- **Earned runs effectively start in 1908.** 1906 records them for 17 of its
  3,090 pitching lines and 1907 for about half. A season that has none sums to
  NULL and shows no ERA at all; 1907 sums what it has, so an ERA for that
  season is a partial numerator over a whole denominator and reads far too low.
  Everything from 1908 is complete — it was 1910 before the summer 2026
  release, which is what those event files bought.
- **Wins, losses, saves, starts, complete games and shutouts are derived, not
  read.** No box score carries them: the decision is a column on the game, and a
  complete game is the fact that his side used nobody else. They are counted per
  season, club and round, which is what makes them agree with the published
  record — lumping the rounds together gives Rivera 44 saves in 1997 rather than
  43, the extra one being the All-Star Game.
- **A league is a property of each side, not of the game.** `league` cannot
  describe a game played between two of them and is NULL for all 10,232 —
  every World Series and interleague game, the Cardinals against the St. Louis
  Giants of the Negro National League in the Octobers of 1920 and 1921, and
  every Negro American League club that met a Negro National League one. The
  filter reads `vis_lg` and `home_lg` and matches either, so such a game
  appears under both leagues rather than being assigned to one. 239,636 games
  carry a league on both sides; the 355 that carry neither are clubs Retrosheet
  gives no circuit for.
- **The kind of game is Retrosheet's word, not ours.** The box files carry
  `info,gametype` and this did not read it for years, so 4,654 games sat under
  a type called `negro` — a league wearing a game type's clothes. The source
  calls them regular seasons, exhibitions, championship series, league
  championship series, All-Star games and one playoff, and that is what they
  are now. 925 of them carry no such record and are read as regular season,
  because a game the source does not describe cannot be described from the
  clubs' names without inventing a record Retrosheet never wrote.
- **Where the game logs and the box files disagree, the log wins.** Sixteen
  box files call a game `playoff` that the game logs count in the regular
  season: the pennant tie-breakers, Thomson's among them. The published record
  counts those in the regular season too, so the log decides for any game it
  carries and the box file's word is used only for the 4,658 games the logs
  never listed.
- **Managers and umpires are on every game; coaches are on none.** 2,709 people
  in the database never played, and their record is counted the same way a
  pitcher's decisions are — from the game rather than from a box score. The
  1,903 coaches have their dates from the biography file and nothing else,
  because no game file names a coach, and the page says so rather than showing
  an empty picker.
- **Retrosheet publishes no season or career totals.** Everything here is summed
  from individual game lines, so totals differ from the official record wherever
  Retrosheet's box scores do — and `data/retrosheet/discrepancies/` is
  Retrosheet documenting exactly where. That is a property of the source.

Two things in the source actively mislead if taken at face value, and
`build_db.py` corrects both:

- **A negative stat means "not recorded", not a number.** Sacrifice flies before
  1954, intentional walks before 1955, caught stealing and GIDP in the early
  years. 12,377 game rows and ~200,000 box lines carry one. Stored as-is they
  don't merely read wrong — `SUM()` subtracts them from a career total. Read as
  NULL via `stat()`.
- **`phline` annotates `bline`, it doesn't add to it.** 470,410 of the 470,415
  pinch-hit records duplicate a batting line already in the file. Loading both
  into one table inflates every pinch-hit appearance in the database. They live
  in `bat` and `pinch_hit` respectively, and only `bat` is ever summed.

And one place the files used to disagree with each other:

- **The Kansas City Athletics were `OAK` in the game logs and `KC1` everywhere
  else**, 1955–1967, which uncorrected cost 1,029 games their box scores.
  Retrosheet fixed it in the summer 2026 release — all 2,060 are `KC1` now — and
  `check_team_fixes` is what said so, reporting the entry as dead the first time
  the new data was built. `TEAM_CODE_FIXES` is empty and stays, for the next one.

- **A game type comes from the name of the file the game arrived in**, and a
  name nobody has taught the build about is filed as regular season. The 1900
  Chronicle-Telegraph Cup came with the summer 2026 release as four games in
  `ebe/`, a folder whose games had until then always been in a game log too;
  synthesised headers from it defaulted to regular, which put a championship
  series into Brooklyn's and Pittsburgh's regular seasons. They are `postseason`
  now — a round a season had before there was a World Series to call it.

## Tests

```sh
./test_views.sh
```

Re-records the API fixtures from a live `app.py`, then renders every view in
JavaScriptCore (which ships with macOS) and checks the markup. Re-recording is
the point — a fixture that has drifted from what `app.py` returns tests nothing.

The fixtures are committed, so the view half runs on a fresh clone with no
database and no server:

```sh
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc test_views.js
```

Use that while working on `static/`; use `test_views.sh` after touching
`app.py`, because only that re-records what the views are tested against.

`test_local_api.js` is the other half, and the more important one: there are
two implementations of every endpoint — Python over SQLite, and JavaScript over
the exported JSON — and nothing but this enforces that they answer the same.
It runs `api-local.js` against the real `docs/data` exports and compares 1,847
fields against the responses recorded from `app.py`. It has already caught four
silent disagreements: a roster sorted by given name rather than surname, an
unstable tie-break in the game list, attendance rounded on one side only, and
NULL leagues sorting last instead of first.

The build itself is checked by reconciling the box scores against the game
logs, which are independent sources for the same games: summed batting lines
match the game log's team totals for **100%** of games in every era, and where
they differ before 1910 it is only because the game log never recorded the stat
and the box score did.

## Yearly update

Retrosheet ships one archive that always points at the current release, so
there is no URL to guess at, and roughly one release a year to apply. Push
whatever is outstanding first: a release rewrites most of `docs/`, and mixed
with a code change neither is reviewable.

```sh
python3 update_data.py     # fetch, verify, rebuild
python3 build_site.py      # re-export docs/
./test_views.sh            # re-record fixtures, run both suites
```

**1. What the download refuses.** A truncated zip unpacks cleanly up to the
byte it was cut off at, so "it opened" proves nothing. `update_data.py` counts
seasons and game-log lines and will not replace what's on disk with fewer of
either. Note that it counts *game logs*: Negro League games are not in them at
all, and a release that adds only box scores or play-by-play will report "no
new games" while changing the database a great deal. That is correct.

**2. What `build_db.py` prints.** Two blocks matter.

*Since the last release* is the diff against `release.json`, which is committed
— the figures a release is judged by, taken from the build rather than from
the release note's prose. `git diff release.json` is the record of what each
release actually did, kept for good. Check it says what Retrosheet said it
would: a season of Negro League games should move `gametypes.negro` and
`games` by the same amount, new box scores for an early year should move
`firstBoxSeason` and `firstBattingSeason`.

*Needs attention* is where a silent misfiling shows up — a dead
`TEAM_CODE_FIXES` entry, a box score with no game row, or a game-log file whose
name is neither `gl<year>` nor a known round. That last one matters: game type
comes from the filename, so an unrecognised one is filed as regular season
without a word, which is how a postseason series ends up in a club's record.
Add it to `SPECIAL_LOGS`.

**3. What will fail, and should.** Several view tests assert career totals
against the published record — Walter Johnson 417–279, Klem's 5,369 games,
Josh Gibson's 633 hits. A release that revises games those men played in will
move them. Read the `release.json` diff first: if it explains the change, the
figures in `test_views.js` are what to update, and they are deliberately hard
to update by accident.

**4. What to re-read in this file.** The counts in the opening paragraph, and
every era claim under *What the data can and can't say*. They are assertions
about a particular release; `release.json` holds the current answers.

## Licence

Code is MIT. The data keeps Retrosheet's terms, which permit commercial use and
redistribution but require the notice to appear prominently — it is in the page
footer and on the About page, and it is a condition of use rather than
decoration. Don't drop it.

> The information used here was obtained free of charge from and is copyrighted
> by Retrosheet. Interested parties may contact Retrosheet at
> [www.retrosheet.org](https://www.retrosheet.org).
