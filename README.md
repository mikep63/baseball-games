# Baseball Games

A zero-dependency local web app over the [Retrosheet](https://www.retrosheet.org)
game and box-score files: **239,442 games, 1871–2025**, of which 219,778 have a
full box score. Python standard library only — no pip installs.

It is the sibling of `baseball-records`, which does the same job over the
Lahman database. That one answers *what did he do in 1927*; this one answers
*what did he do on the 12th of August*. **A change to one front end is not
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
| **Games** | every game, filterable by season, club, park, date and type |
| **Game** | line score, both box scores, itemised HR/SB/CS/DP/HBP, umpires, weather, attendance |
| **Player** | bio, season-by-season batting/pitching/fielding, and every game he played |
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

`docs/` is about 455 MB and **is committed**, which is the cost of serverless
hosting. Most shards are byte-identical between releases, so the yearly growth
is the seasons that actually changed rather than another full copy.

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

- **Results go back to 1871, batting lines only to 1898.** The game logs for
  1873–1897 carry the score and nothing else — no team batting totals, let
  alone per-player ones. 24 seasons, ~19,000 games.
- **Play-by-play is complete for the AL and NL from 1910**, which is earlier
  than Retrosheet's reputation suggests. Three seasons are one game short. The
  Federal League of 1914–15 has box scores but no play-by-play, which is the
  whole of the apparent gap in those years.
- **Pitch sequences effectively start in 1988** (~88% of plays since; near zero
  before).
- **Negro League games are not in the game logs at all.** Their headers here are
  synthesised from the box-score files, and Retrosheet notes most were deduced
  from newspaper accounts.
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

And one place the files disagree with each other:

- **The Kansas City Athletics are `OAK` in the game logs and `KC1` everywhere
  else**, 1955–1967. Every other club in every other era agrees. Uncorrected it
  costs 1,029 games their box scores. `TEAM_CODE_FIXES` handles it and
  `check_team_fixes` reports the entry as dead if a future release fixes it
  upstream.

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
there is no URL to guess at:

```sh
python3 update_data.py
```

It refuses a download that has lost seasons or games relative to what's on
disk, then rebuilds. Afterwards, re-read the "Needs attention" block that
`build_db.py` prints — it is where a changed team code or a corrected upstream
quirk will show up.

## Licence

Code is MIT. The data keeps Retrosheet's terms, which permit commercial use and
redistribution but require the notice to appear prominently — it is in the page
footer and on the About page, and it is a condition of use rather than
decoration. Don't drop it.

> The information used here was obtained free of charge from and is copyrighted
> by Retrosheet. Interested parties may contact Retrosheet at
> [www.retrosheet.org](https://www.retrosheet.org).
