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
  "games?season=1927&limit=400&date=1927-07-04" \
  "game/NYA195610080" \
  "player/ruthb101" \
  "player/ruthb101/games?season=1927" \
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
  "$JSC" test_local_api.js
else
  echo
  echo "docs/ not built — skipping the local-API agreement check."
  echo "Run build_site.py first to include it."
fi
