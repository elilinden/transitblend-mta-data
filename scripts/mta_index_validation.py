"""Bounded, credential-free validation shared by the builder and release publisher."""
import argparse
import datetime as dt
import gzip
import hashlib
import json
import pathlib
import re

SOURCE = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip"
MAX_GZIP = 20_000_000
MAX_JSON = 150_000_000

def timestamp(value):
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError("Invalid timestamp")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamp needs timezone")
    return parsed.timestamp()

def validate_index(index, minimum_trips=1, now=None):
    now = dt.datetime.now(dt.timezone.utc).timestamp() if now is None else now
    if not isinstance(index, dict) or index.get("version") != 1 or index.get("source") != SOURCE:
        raise ValueError("Invalid schedule schema/source")
    generated = timestamp(index.get("generatedAt"))
    if not -60 <= now - generated <= 7200:
        raise ValueError("Schedule is stale or future-dated")
    trips = index.get("trips")
    if not isinstance(trips, list) or not minimum_trips <= len(trips) <= 150_000:
        raise ValueError("Invalid trip count")
    stops = 0
    def identity(value):
        return isinstance(value, str) and 0 < len(value) <= 180 and not re.search(r"[\x00-\x1f]", value)
    def integer(value, maximum):
        return type(value) is int and 0 <= value <= maximum
    for trip in trips:
        if not isinstance(trip, dict) or not all(identity(trip.get(key)) for key in ("tripId", "realtimeTripId", "routeId")) or type(trip.get("directionId")) is not int or trip["directionId"] not in (0, 1):
            raise ValueError("Invalid trip identity")
        native = re.search(r"(?:^|_)(-?\d{6,8}_[A-Z0-9]+\.\.[NS][A-Z0-9]+)$", trip["tripId"])
        if not native or native[1] != trip["realtimeTripId"]:
            raise ValueError("Trip does not preserve its native MTA identity")
        dates = trip.get("serviceDates")
        if not isinstance(dates, list) or not 1 <= len(dates) <= 16:
            raise ValueError("Missing service dates")
        for day in dates:
            if not isinstance(day, str) or not re.fullmatch(r"\d{8}", day):
                raise ValueError("Invalid service date")
            dt.date(int(day[:4]), int(day[4:6]), int(day[6:]))
        events = trip.get("stops")
        if not isinstance(events, list) or not 2 <= len(events) <= 200:
            raise ValueError("Invalid stop count")
        sequence, departure = -1, -1
        for stop in events:
            if not isinstance(stop, list) or len(stop) != 4 or not identity(stop[0]) or not integer(stop[1], 259200) or not integer(stop[2], 259200) or not integer(stop[3], 100000) or stop[1] > stop[2] or stop[3] <= sequence or stop[1] < departure:
                raise ValueError("Invalid stop chronology")
            sequence, departure = stop[3], stop[2]
        stops += len(events)
        if stops > 3_000_000:
            raise ValueError("Too many stop events")
    return dict(generatedAt=index["generatedAt"], tripCount=len(trips), stopCount=stops, source=SOURCE)

def inspect_file(path, minimum_trips=1):
    if path.stat().st_size > MAX_GZIP:
        raise ValueError("Compressed schedule too large")
    raw = path.read_bytes()
    if len(raw) > MAX_GZIP:
        raise ValueError("Compressed schedule too large")
    with gzip.open(path, "rb") as stream:
        data = stream.read(MAX_JSON + 1)
    if len(data) > MAX_JSON:
        raise ValueError("Expanded schedule too large")
    result = validate_index(json.loads(data), minimum_trips)
    return dict(result, sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("index", type=pathlib.Path)
    parser.add_argument("--minimum-trips", type=int, default=1000)
    args = parser.parse_args()
    try:
        print(json.dumps(inspect_file(args.index, args.minimum_trips)))
    except Exception:
        raise SystemExit("Schedule validation failed; publication refused.")
