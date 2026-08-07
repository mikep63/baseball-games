#!/usr/bin/env python3
"""Fetch the current Retrosheet release and rebuild retro.sqlite.

Usage:
  python3 update_data.py                 # download the latest alldata.zip
  python3 update_data.py --zip file.zip  # use an already-downloaded zip
  python3 update_data.py --url <url>     # pull from a different source
  python3 update_data.py --keep-db       # swap the files only, don't rebuild

Retrosheet ships everything in one archive rather than a folder per season, so
there is no yearly URL to guess at: the same link always points at the current
release. What changes is the contents, which is why this checks the new archive
against the old one before replacing anything.
"""
import argparse
import glob
import os
import re
import shutil
import sys
import tempfile
import urllib.request
import zipfile

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE, "data", "retrosheet")
DEFAULT_URL = "https://retrosheet.org/downloads/alldata.zip"

# Folders that must be present for the archive to be accepted as a Retrosheet
# release. Deliberately not the full list — Retrosheet adds folders (ngl_e and
# ngl_b arrived with the Negro Leagues work) and a new one shouldn't be
# grounds for refusing the download.
REQUIRED = ["gamelogs", "events", "boxes", "biodata", "rosters"]


def seasons_in(root):
    """The set of seasons the game logs cover, as a coverage fingerprint."""
    out = set()
    for path in glob.glob(os.path.join(root, "gamelogs", "gl[0-9][0-9][0-9][0-9].txt")):
        m = re.search(r"(\d{4})", os.path.basename(path))
        if m:
            out.add(int(m.group(1)))
    return out


def game_count(root):
    n = 0
    for path in glob.glob(os.path.join(root, "gamelogs", "gl*.txt")):
        with open(path, encoding="latin-1") as f:
            n += sum(1 for _ in f)
    return n


def download(url, dest):
    print("Downloading %s ..." % url)
    req = urllib.request.Request(url, headers={"User-Agent": "baseball-games-updater"})
    with urllib.request.urlopen(req) as resp, open(dest, "wb") as out:
        shutil.copyfileobj(resp, out)
    print("  %.0f MB" % (os.path.getsize(dest) / 1e6))


def extract(zip_path, work_dir):
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        tops = {n.split("/")[0] for n in names if "/" in n}
        missing = [r for r in REQUIRED if r not in tops]
        if missing:
            sys.exit("Archive is missing: %s\nFound: %s"
                     % (", ".join(missing), ", ".join(sorted(tops))))
        print("Extracting %d files ..." % len(names))
        zf.extractall(work_dir)
    return sorted(tops)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--url", default=DEFAULT_URL, help="source zip URL")
    ap.add_argument("--zip", dest="zip_path", help="use a local zip instead of downloading")
    ap.add_argument("--keep-db", action="store_true", help="skip rebuilding retro.sqlite")
    args = ap.parse_args()

    old_seasons = seasons_in(DATA_DIR) if os.path.isdir(DATA_DIR) else set()
    old_games = game_count(DATA_DIR) if old_seasons else 0

    with tempfile.TemporaryDirectory() as tmp:
        zip_path = args.zip_path
        if not zip_path:
            zip_path = os.path.join(tmp, "alldata.zip")
            download(args.url, zip_path)
        elif not os.path.exists(zip_path):
            sys.exit("zip not found: %s" % zip_path)

        work = os.path.join(tmp, "retrosheet")
        os.makedirs(work)
        folders = extract(zip_path, work)
        print("Folders: %s" % ", ".join(folders))

        # Sanity-check the new data before touching what's on disk. A truncated
        # download unzips cleanly right up to the point it was cut off, so
        # "the zip opened" is not evidence that the data is whole.
        new_seasons = seasons_in(work)
        new_games = game_count(work)
        if len(new_seasons) < 100:
            sys.exit("New archive covers only %d seasons — refusing to replace data"
                     % len(new_seasons))
        if old_seasons:
            lost = old_seasons - new_seasons
            if lost:
                sys.exit("New archive is missing seasons we already have: %s"
                         % ", ".join(str(y) for y in sorted(lost)))
            if new_games < old_games:
                sys.exit("New archive has %d games but current data has %d — "
                         "refusing to downgrade" % (new_games, old_games))

        old_dir = DATA_DIR + ".old"
        if os.path.exists(old_dir):
            shutil.rmtree(old_dir)
        if os.path.exists(DATA_DIR):
            os.rename(DATA_DIR, old_dir)
        os.makedirs(os.path.dirname(DATA_DIR), exist_ok=True)
        shutil.move(work, DATA_DIR)
        if os.path.exists(old_dir):
            shutil.rmtree(old_dir)

    latest = max(new_seasons)
    if old_seasons and max(old_seasons) == latest:
        added = new_games - old_games
        print("Data refreshed; still ends at %d. %s"
              % (latest, "%+d games." % added if added else "No new games."))
    else:
        print("Data updated: %s -> %d season, %d games."
              % (max(old_seasons) if old_seasons else "?", latest, new_games))

    if args.keep_db:
        print("Skipping database rebuild (--keep-db).")
        return
    print()
    import build_db
    build_db.main()


if __name__ == "__main__":
    main()
