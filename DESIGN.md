# Design decisions

Settled decisions and the alternatives that lost, so they are not re-argued.

What belongs here: a choice where something else was seriously considered, and
the reason it was not taken. What does not: how the code works, which is what
the code comments are for; why a particular change was made, which is in the
commit that made it (`git log --grep`); what the data can and can't say, which
is README.md.

This file covers both this repository and `baseball-records`, because the
decisions worth writing down about either are decisions about the pair.
`baseball-records/DESIGN.md` points here rather than repeating the argument
where the two copies could drift.

If an entry here is ever reopened, edit it and say why rather than adding a
second entry that disagrees with the first.

---

## Two apps, not one · proposed 2026-08-25

**Status: proposed, not settled.** The question was asked and analysed; what
follows is a recommendation awaiting a decision, and the cross-link it proposes
is not built.

The question: `baseball-games` and `baseball-records` are visibly siblings —
same stdlib-only Python server, same `docs/` Pages build, same `api-local.js`
reimplementation of the API in the browser, same column orders. Is there one
app to be made out of the best of both?

Recommendation: **no — keep two apps, and cross-link them.**

### What they share is architecture, not code

Measured rather than guessed. Sorting each file pair and intersecting them —
which over-counts, since it scores every `});` as a match — gives 50 shared
lines of 1,050 in `app.py` and 19 of 916 in `build_db.py`. The only substantial
block genuinely the same in both is Favorites: about 74 lines of `localStorage`
star, identical but for the key (`baseball-games:favorites` against
`baseball-records:favorites`). Everything else diverged for reasons. The
stylesheets differ across 517 diff lines over ~290 lines each, and this app's
1,888-line `app.js` is mostly box scores, `describePlay` and Retrosheet-specific
caveats that Lahman has no use for.

A merge would therefore not be deleting duplicate code — there is barely any. It
would be teaching one frontend two data models.

The parity a merge would be *for* already exists where it pays, as a convention
rather than a shared module: `app.js` here carries the note that column orders
follow `baseball-records` so the two put the same stat in the same place.
Vendoring 74 lines of Favorites into a shared file, across two repositories
whose whole premise is that they install nothing, costs more ceremony than the
duplication does.

### The deployment profiles do not fit one budget

`baseball-records/docs` is 18 MB and an offline PWA — service worker, manifest,
~5 MB on the phone, works with no connection. `baseball-games/docs` is 632 MB
against GitHub Pages' 1 GB cap, and the play shards are gzipped specifically to
fit under it.

One site puts both under a single 1 GB budget, with Retrosheet growing its half
every release. It also ends the PWA: nobody caches 632 MB on a phone, and
"works on the plane" is one of the records app's better properties, which exists
only because that app is small.

### They answer different questions, off differently-licensed sources

The README here already draws the line: records answers *what did he do in
1927*, this one answers *what did he do on the 12th of August*. That is also a
licensing seam — Lahman is CC BY-SA 3.0, Retrosheet carries its own notice
condition — and two update cadences against two upstreams. With
`baseball-games-ios` pending and counted as a front end by the parity rule in
CLAUDE.md, it is a poor moment to restructure the web app underneath it.

### Rejected

- **Merge into one app**, for the three reasons above.
- **A shared frontend library across the two repositories.** There is nothing
  to put in it but Favorites, and vendoring is the only way to ship it without
  taking a dependency.
- **A third repository for shared design notes.** One document is less ceremony
  than a repository to hold it, which is why this file lives here.

### Followup: cross-link the two instead

This is the part of a merge actually worth having, and it is an afternoon
rather than a rewrite.

Lahman publishes the join. `People.retroID` carries a Retrosheet id for 23,373
of its 24,270 people — 96.3% — and it is exact rather than a name match:
Lahman's `ruthba01` gives `ruthb101`, which is `person.id` here. SABR maintains
it, so there is no matching heuristic to write and none to keep working.

What it buys is what the merge was for. Start at a season line in records and
land on the games behind it; start at a box score here and get the official
career totals.

What it needs:

- `baseball-records` exports `retroID` on the player payload and renders a link
  out. That half is in that repository.
- This app maps the other way. Its 27,049 people against Lahman's 23,373
  matchable ones leaves roughly a seventh with no counterpart, and that side is
  mostly umpires, coaches and managers — 2,709 people here never played at all.
  No link is drawn where there is no id.
- **The two hash conventions differ**, so a link must be written in the target
  app's own form: `#/player/<retroID>` here (leading slash, `parseHash` filters
  empties), `#player/<playerID>` there (no leading slash — that router reads
  `parts[0]` directly and a leading slash breaks it).
- Both ends are static sites, so a link is a URL and nothing more: no API
  coupling, no build-time dependency, and a stale link degrades to a 404 rather
  than breaking either app.

The one thing to be honest about on the page: **the totals will disagree.**
Retrosheet publishes no season or career totals, so everything here is summed
from individual game lines and differs from the official record wherever the
box scores do — `data/retrosheet/discrepancies/` is Retrosheet documenting
where. Each app keeps its own numbers. The link makes the relationship visible
and must not imply the two are the same number.

If the export moves data between files, `EXPORT_SHAPE` in `build_site.py` and
`SHAPE` in `api-local.js` bump together — see CLAUDE.md.
