# Working on baseball-games

Read `README.md` first — it carries the reasoning, and *What the data can and
can't say* is the part most likely to stop you shipping a wrong number.

## The rule everything else serves

There is **one frontend over two backings**: `app.py` (Python over SQLite) and
`api-local.js` (JavaScript over the exported JSON in `docs/data`). `app.js`
cannot tell them apart, and nothing enforces that but `test_local_api.js`.

**`app.py` is the reference implementation.** Where the two disagree, it is
right and the export is wrong. Where the export stores something under a
shorter name — `on` for `runners_on`, `birthCity` for `birth_city` — the
translation belongs in `api-local.js`, not in the view.

A change to a query in `app.py` is half a change. The other half is the export,
and `test_views.sh` is what says so.

## Before you call anything done

```sh
./test_views.sh          # re-records fixtures from a live app.py, then both suites
```

It must end with **"all N checks pass"** and **"all N endpoints agree with
app.py"**. Re-recording is the point: a fixture that has drifted from what
`app.py` returns tests nothing.

If you changed anything the export touches, rebuild it first, or the parity
half is testing yesterday's data:

```sh
python3 build_db.py      # ~4 min; only if build_db.py or data/ changed
python3 build_site.py    # ~3 min; writes docs/
./test_views.sh
```

Working on `static/` alone? `jsc test_views.js` runs the view half in seconds
with no database and no server.

## What is committed and what is not

| | |
|---|---|
| `docs/` | **committed**, ~639 MB — this is the deployed site |
| `retro.sqlite`, `data/` | gitignored, ~2.7 GB and ~2.1 GB, both derived |
| `release.json` | committed — the fingerprint each build diffs against |

**GitHub Pages caps a published site at 1 GB.** `docs/` is at about 639 MB, and
that headroom is why the play shards are gzipped rather than plain. Check the
number before adding anything large.

Nothing at runtime contacts Retrosheet. `update_data.py` is the only thing that
reaches the network, about once a year.

## Conventions worth keeping

- **A NULL is not a zero.** Retrosheet writes a negative or a blank for "not
  recorded", and the codebase reads those as NULL throughout. Summing them as
  zeroes, or printing `0.00` for one, is the bug this project most often grows.
- **Split by round.** Season totals are grouped by game type, because counting
  the World Series into the regular season is how Lasorda's 1977 reads 103-69
  instead of 98-64.
- **Say what the source says.** Retrosheet's own vocabulary wins over an
  invented one — game types come from `info,gametype`, not from which folder a
  file arrived in. Where the source is silent, say so on the page rather than
  inferring from names.
- Comments explain *why*, with the number that makes the case. Match the
  surrounding density.

## Gotchas

- Running `build_site.py` twice in quick succession can leave macOS duplicate
  files — in `careers/` as well as `plays/`, and numbered " 3" after a third
  run, so a `* 2.json.gz` sweep misses most of them. Clear them before
  committing: `find docs -regex '.* [0-9]+\.json\(\.gz\)?' -delete`
- `SCHEMA` in `build_db.py` is `%`-formatted — a literal `%` in a SQL comment
  there will break the build.
- JavaScriptCore has no `fetch`, `Response`, `TextDecoder` or
  `DecompressionStream`. The test harnesses shim what they need, and
  `test_views.sh` inflates the gzipped shards the parity test reads.
- The README says an iOS port counts as a front end. It does not exist yet.
