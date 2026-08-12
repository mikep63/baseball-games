#!/bin/sh
# Re-record the API fixtures and run the view tests against them.
#
# There is no browser and no build step in this project, so the views are
# exercised in JavaScriptCore (which ships with macOS) against real responses
# rather than hand-written stubs. Re-recording is the point: a fixture that
# drifts from what app.py actually returns tests nothing.
set -e
cd "$(dirname "$0")"

PORT=${PORT:-8099}
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc

[ -f retro.sqlite ] || { echo "No retro.sqlite — run build_db.py first."; exit 1; }
[ -x "$JSC" ] || { echo "No JavaScriptCore at $JSC"; exit 1; }

python3 app.py --port "$PORT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 2

# The three games URLs are the three requests viewGames actually makes, spelt
# exactly as it spells them -- the fixture is looked up by URL, so limit=0 (the
# calendar with no day picked) has to be recorded as limit=0.
mkdir -p fixtures
for u in \
  "meta" \
  "teams?season=1927" \
  "games?season=1927&limit=0" \
  "games?season=1927&limit=0&gametype=regular" \
  "games?season=1927&limit=400&team=NY1" \
  "games?season=1927&limit=400&gametype=worldseries" \
  "games?season=1927&limit=400&park=NYC16" \
  "games?season=1985&limit=400&team=BAL&park=BLO01" \
  "teams?season=1985" \
  "teams?season=1933" \
  "teams?season=2024" \
  "games?season=2024&limit=0" \
  "teams?season=1933&league=NN2" \
  "teams?season=1920&league=MLB" \
  "games?season=1933&limit=0" \
  "games?season=1933&limit=400&league=NN2" \
  "games?season=1920&limit=400&league=NN1" \
  "teams?season=1871" \
  "games?season=1871&limit=400&date=1871-05-04" \
  "park/BLO01" \
  "games?season=1927&limit=400&date=1927-07-04" \
  "game/NYA195610080" \
  "game/LAN198610050" \
  "game/NYA195610080/plays" \
  "game/LAN198610050/plays" \
  "player/ruthb101" \
  "player/ruthb101/games?season=1927" \
  "player/gibsj101" \
  "player/johnw102" \
  "player/lasot101" \
  "player/lasot101/games?season=1977" \
  "player/klemb901" \
  "player/klemb901/games?season=1905" \
  "team/NYA?season=1927" \
  "team/NYA" \
  "park/NYC16" \
  "search?q=ruth"
do
  f=$(printf '%s' "$u" | tr '/?&=' '____')
  curl -sf "http://127.0.0.1:$PORT/api/$u" -o "fixtures/$f.json"
done
echo "Recorded $(ls fixtures/*.json | wc -l | tr -d ' ') fixtures"

"$JSC" test_views.js

# The docs/ build reimplements every endpoint in the browser. Nothing but this
# stops it drifting from app.py, so run it whenever the exports exist.
if [ -d docs/data ]; then
  echo
  # The play shards are gzipped so the site fits inside the 1 GB GitHub Pages
  # allows. JavaScriptCore has no DecompressionStream -- no fetch, Response or
  # TextDecoder either -- so the shell inflates the handful the test reads and
  # the harness serves those. The alternative was vendoring an inflate into a
  # project that has no dependencies and no build step.
  rm -rf .plays-inflated && mkdir -p .plays-inflated
  for f in docs/data/plays/NYA1956.json.gz docs/data/plays/LAN1986.json.gz; do
    [ -f "$f" ] && gunzip -c "$f" > ".plays-inflated/$(basename "$f" .gz)"
  done
  "$JSC" test_local_api.js
  rm -rf .plays-inflated
else
  echo
  echo "docs/ not built — skipping the local-API agreement check."
  echo "Run build_site.py first to include it."
fi
