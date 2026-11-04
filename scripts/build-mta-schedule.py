"""Build a compact subway schedule index outside rider requests; no credentials needed."""
import argparse
import csv
import datetime as dt
import gzip
import io
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from zoneinfo import ZoneInfo
from mta_index_validation import validate_index, inspect_file

def stop_refresh(_signal, _frame):
    raise KeyboardInterrupt("Schedule refresh stopped")

signal.signal(signal.SIGTERM, stop_refresh)

SOURCE = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip"
ROOT = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--archive", type=pathlib.Path, help="Use an already downloaded official supplemented GTFS ZIP")
parser.add_argument("--output", type=pathlib.Path, default=ROOT / ".local/mta/schedule-index.json.gz")
args = parser.parse_args()
archive = args.archive or ROOT / ".local/mta/gtfs_supplemented.zip"
archive.parent.mkdir(parents=True, exist_ok=True)
if not args.archive:
    with tempfile.NamedTemporaryFile(dir=archive.parent, delete=False) as target:
        temporary_archive = pathlib.Path(target.name)
    try:
        # macOS's system curl uses the trusted system certificate store. Some
        # Python distributions ship without a configured root-certificate bundle.
        curl = "/usr/bin/curl" if sys.platform == "darwin" and pathlib.Path("/usr/bin/curl").is_file() else shutil.which("curl")
        if curl:
            subprocess.run([curl, "--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https", "--max-time", "60", "--max-filesize", "50000000", "--output", str(temporary_archive), SOURCE], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=65)
        else:
            with urllib.request.urlopen(SOURCE, timeout=60) as response, temporary_archive.open("wb") as target:
                downloaded = 0
                while chunk := response.read(1024 * 1024):
                    downloaded += len(chunk)
                    if downloaded > 50_000_000:
                        raise ValueError("Official archive exceeded the supported size")
                    target.write(chunk)
        if temporary_archive.stat().st_size > 50_000_000:
            raise ValueError("Official archive exceeded the supported size")
        os.replace(temporary_archive, archive)
    except BaseException:
        temporary_archive.unlink(missing_ok=True)
        raise
if archive.stat().st_size > 50_000_000:
    raise SystemExit("Archive exceeds the supported size")

today = dt.datetime.now(ZoneInfo("America/New_York")).date()
days = [today + dt.timedelta(days=n) for n in range(-1, 7)]
date_keys = {day.strftime("%Y%m%d"): day for day in days}
active = {key: set() for key in date_keys}
allowed = set("1234567ABCDEFGJLMNQRWZ") | {"6X", "7X", "S", "GS", "FS", "H"}
with zipfile.ZipFile(archive) as source:
    def rows(name):
        if name not in source.namelist():
            return
        if source.getinfo(name).file_size > 180_000_000:
            raise ValueError("Schedule table exceeds the supported size")
        with source.open(name) as raw:
            yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))

    if not any(row.get("agency_id") == "MTA NYCT" and row.get("agency_timezone") == "America/New_York" for row in rows("agency.txt")):
        raise ValueError("Use the official MTA NYCT subway archive in America/New_York")

    weekday = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    for row in rows("calendar.txt"):
        for key, day in date_keys.items():
            if row["start_date"] <= key <= row["end_date"] and row[weekday[day.weekday()]] == "1":
                active[key].add(row["service_id"])
    for row in rows("calendar_dates.txt"):
        if row["date"] in active:
            if row["exception_type"] == "1":
                active[row["date"]].add(row["service_id"])
            elif row["exception_type"] == "2":
                active[row["date"]].discard(row["service_id"])
    trips = {}
    for row in rows("trips.txt"):
        dates = [key for key in active if row["service_id"] in active[key]]
        native = re.search(r"(?:^|_)(-?\d{6,8}_[A-Z0-9]+\.\.[NS][A-Z0-9]+)$", row["trip_id"])
        if dates and native and row["route_id"] in allowed and row["direction_id"] in ("0", "1"):
            trips[row["trip_id"]] = dict(tripId=row["trip_id"], realtimeTripId=native[1], routeId=row["route_id"], directionId=int(row["direction_id"]), serviceDates=dates, stops=[])
        if len(trips) > 150_000:
            raise ValueError("Too many active schedule trips")

    def seconds(text):
        match = re.fullmatch(r"(\d{1,3}):(\d{2}):(\d{2})", text)
        if not match or int(match[2]) > 59 or int(match[3]) > 59:
            return None
        return int(match[1]) * 3600 + int(match[2]) * 60 + int(match[3])

    stop_count = 0
    for row in rows("stop_times.txt"):
        trip = trips.get(row["trip_id"])
        if trip:
            arrival, departure = seconds(row["arrival_time"]), seconds(row["departure_time"])
            if arrival is not None and departure is not None:
                trip["stops"].append([row["stop_id"], arrival, departure, int(row["stop_sequence"])])
                stop_count += 1
                if stop_count > 3_000_000:
                    raise ValueError("Too many schedule stop events")

for trip in trips.values():
    trip["stops"].sort(key=lambda stop: stop[3])
generated = dt.datetime.fromtimestamp(min(archive.stat().st_mtime, dt.datetime.now().timestamp()), dt.timezone.utc).isoformat()
index = dict(version=1, generatedAt=generated, source=SOURCE, trips=list(trips.values()))
validate_index(index)
args.output.parent.mkdir(parents=True, exist_ok=True)
with tempfile.NamedTemporaryFile(dir=args.output.parent, prefix=args.output.name + ".", suffix=".tmp", delete=False) as target:
    temporary = pathlib.Path(target.name)
try:
    with gzip.open(temporary, "wt", encoding="utf-8") as target:
        json.dump(index, target, separators=(",", ":"))
    inspect_file(temporary)
    os.replace(temporary, args.output)
except BaseException:
    temporary.unlink(missing_ok=True)
    raise
print(json.dumps(dict(path=str(args.output), trips=len(trips), stopEvents=stop_count, bytes=args.output.stat().st_size, generatedAt=generated, serviceDates=list(date_keys))))
