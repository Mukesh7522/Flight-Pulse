"""
FlightPulse Global — OpenSky → Supabase Ingestion Script
=========================================================
Run: python ingestion/fetch_flights.py

Loops every 60 seconds:
  1. Fetch all live flight states from OpenSky Network (free, no auth needed)
  2. Validate + clean the data
  3. Upsert into `flights_live` (replace current snapshot)
  4. Append to `flights_history` (24h ring buffer)
  5. Purge history older than 24h
  6. Log the run to `pipeline_runs`
"""

import os
import re
import time
import logging
import urllib.parse
import requests
import pg8000.dbapi as pgdb
from datetime import datetime, timezone
from dotenv import load_dotenv

# ── Config ────────────────────────────────────────────────────────────────────

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))

DATABASE_URL         = os.environ["DATABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# Derive Supabase REST URL from DATABASE_URL — handles both URL formats:
#   Transaction pooler: postgresql://postgres.PROJECTREF:PASSWORD@aws-...pooler.supabase.com:6543/...
#   Direct connection:  postgresql://postgres:PASSWORD@db.PROJECTREF.supabase.co:5432/...
_ref = re.match(r'postgresql://postgres\.([^:]+):', DATABASE_URL)
if _ref:
    SUPABASE_REST_URL = f"https://{_ref.group(1)}.supabase.co"
else:
    _ref2 = re.search(r'@db\.([^.]+)\.supabase\.co', DATABASE_URL)
    SUPABASE_REST_URL = f"https://{_ref2.group(1)}.supabase.co" if _ref2 else ""

# OpenSky OAuth2 client credentials — gives 4000 state vectors/10s (vs 400 anonymous)
# Tokens last 300s; we auto-refresh before expiry.
OPENSKY_CLIENT_ID     = os.environ.get("OPENSKY_CLIENT_ID")
OPENSKY_CLIENT_SECRET = os.environ.get("OPENSKY_CLIENT_SECRET")
OPENSKY_TOKEN_URL     = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"

OPENSKY_URL      = "https://opensky-network.org/api/states/all"
OPENSKY_TIMEOUT  = 30   # seconds
FETCH_INTERVAL   = 180  # seconds — 480 requests/day, ~3.5 GB outbound/month (under 5 GB)

# ── OAuth2 token cache ────────────────────────────────────────────────────────
_token: str | None = None
_token_expiry: float = 0.0

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("flightpulse")


# ── OpenSky field indexes ─────────────────────────────────────────────────────
#  0  icao24          hex transponder ID
#  1  callsign        flight number / registration
#  2  origin_country
#  5  longitude       WGS-84 degrees
#  6  latitude
#  7  baro_altitude   meters
#  8  on_ground
#  9  velocity        m/s
# 10  true_track      degrees (0=N, clockwise)
# 11  vertical_rate   m/s
# 13  geo_altitude    meters (GPS-based)

def parse_state(s: list) -> dict | None:
    """Parse one OpenSky state vector. Returns None if critically malformed."""
    try:
        icao24 = str(s[0]).strip().lower()
        if not icao24:
            return None

        lat = s[6]
        lon = s[5]
        on_ground = bool(s[8])

        if (lat is None or lon is None) and not on_ground:
            return None

        return {
            "icao24":         icao24,
            "callsign":       str(s[1]).strip() if s[1] else None,
            "origin_country": s[2] if s[2] else None,
            "lon":            float(lon)   if lon  is not None else None,
            "lat":            float(lat)   if lat  is not None else None,
            "baro_altitude":  float(s[7])  if s[7]  is not None else None,
            "geo_altitude":   float(s[13]) if s[13] is not None else None,
            "on_ground":      on_ground,
            "velocity":       float(s[9])  if s[9]  is not None else None,
            "true_track":     float(s[10]) if s[10] is not None else None,
            "vertical_rate":  float(s[11]) if s[11] is not None else None,
        }
    except Exception as e:
        log.debug(f"Skipping malformed state vector: {e}")
        return None


def get_opensky_token() -> str | None:
    """Return a cached OAuth2 bearer token, refreshing if within 60s of expiry."""
    global _token, _token_expiry
    if not OPENSKY_CLIENT_ID or not OPENSKY_CLIENT_SECRET:
        return None
    if _token and time.time() < _token_expiry - 60:
        return _token
    log.info("Refreshing OpenSky OAuth2 token...")
    try:
        resp = requests.post(OPENSKY_TOKEN_URL, data={
            "grant_type":    "client_credentials",
            "client_id":     OPENSKY_CLIENT_ID,
            "client_secret": OPENSKY_CLIENT_SECRET,
        }, timeout=15)
        resp.raise_for_status()
        data          = resp.json()
        _token        = data["access_token"]
        _token_expiry = time.time() + data.get("expires_in", 300)
        log.info("OpenSky token obtained, expires in %ss", data.get("expires_in", 300))
        return _token
    except Exception as e:
        log.warning("OpenSky OAuth2 token fetch failed (%s) — falling back to anonymous", e)
        return None


def fetch_opensky() -> tuple[list[dict], int]:
    """Fetch all live flights from OpenSky. Returns (records, latency_ms)."""
    t0    = time.monotonic()
    token = get_opensky_token()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    if not token:
        log.warning("No OAuth2 token — using anonymous request (low rate limit)")
    try:
        resp = requests.get(OPENSKY_URL, headers=headers, timeout=OPENSKY_TIMEOUT)
    except requests.exceptions.Timeout:
        fetch_ms = int((time.monotonic() - t0) * 1000)
        log.warning("OpenSky API timed out after %dms — IP may be blocked, skipping run", fetch_ms)
        return [], fetch_ms
    if resp.status_code == 429:
        retry_after = int(resp.headers.get("Retry-After", 120))
        log.warning(f"OpenSky 429 rate limited — backing off {retry_after}s")
        time.sleep(retry_after)
        raise RuntimeError(f"429 rate limited (backed off {retry_after}s)")
    resp.raise_for_status()
    fetch_ms = int((time.monotonic() - t0) * 1000)

    states = resp.json().get("states") or []
    log.info(f"OpenSky returned {len(states):,} state vectors in {fetch_ms}ms")

    records = [r for s in states if (r := parse_state(s))]
    log.info(f"Valid records after parsing: {len(records):,}")
    return records, fetch_ms


def upsert_live(records: list[dict]) -> int:
    """Upsert flights_live via Supabase REST API (PostgREST).
    HTTP avoids PgBouncer's 15s statement timeout entirely."""
    if not SUPABASE_REST_URL or not SUPABASE_SERVICE_KEY:
        raise RuntimeError("SUPABASE_SERVICE_KEY not set — add it to GitHub Secrets")
    headers = {
        "apikey":        SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates,return=minimal",
    }
    url     = f"{SUPABASE_REST_URL}/rest/v1/flights_live"
    now_iso = datetime.now(timezone.utc).isoformat()
    CHUNK   = 1000
    for i in range(0, len(records), CHUNK):
        chunk = [{**r, "ingested_at": now_iso} for r in records[i:i + CHUNK]]
        resp  = requests.post(url, headers=headers, json=chunk, timeout=60)
        resp.raise_for_status()
        log.info("HTTP upserted rows %d–%d", i + 1, min(i + CHUNK, len(records)))
    return len(records)


def insert_history(cur, records: list[dict]) -> None:
    """Append current snapshot to flights_history."""
    sql = """
        INSERT INTO flights_history
          (icao24, callsign, origin_country, lon, lat,
           baro_altitude, geo_altitude, on_ground, velocity, true_track, vertical_rate)
        VALUES %s
    """
    rows = [(r['icao24'], r['callsign'], r['origin_country'], r['lon'], r['lat'],
             r['baro_altitude'], r['geo_altitude'], r['on_ground'], r['velocity'],
             r['true_track'], r['vertical_rate']) for r in records]
    psycopg2.extras.execute_values(cur, sql, rows, page_size=500)


def purge_history(cur) -> None:
    """Delete history records older than 1 hour (keeps storage ~270 MB)."""
    cur.execute("SELECT purge_old_history()")
    log.info("Purged history older than 1 hour")


def upsert_anomaly_hourly(cur) -> None:
    """Upsert this hour's anomaly counts from flights_live into anomaly_hourly.
    anomaly_hourly has max 24 rows — powers the 24h chart without history scanning."""
    cur.execute("""
        INSERT INTO anomaly_hourly (hour_utc, ghost_count, low_alt_count, updated_at)
        SELECT
            date_trunc('hour', now()),
            COUNT(*) FILTER (
                WHERE ingested_at < now() - INTERVAL '2 minutes' AND NOT on_ground
            ),
            COUNT(*) FILTER (
                WHERE NOT on_ground
                  AND geo_altitude IS NOT NULL
                  AND geo_altitude * 3.28084 < 3000
                  AND geo_altitude * 3.28084 > 0
            ),
            now()
        FROM flights_live
        ON CONFLICT (hour_utc) DO UPDATE SET
            ghost_count   = EXCLUDED.ghost_count,
            low_alt_count = EXCLUDED.low_alt_count,
            updated_at    = now()
    """)
    cur.execute("SELECT purge_old_anomaly_hourly()")


def purge_stale_live(cur) -> None:
    """Remove flights_live rows not seen in the last 30 minutes.
    Prevents stale zombie rows from inflating ghost counts."""
    cur.execute("DELETE FROM flights_live WHERE ingested_at < now() - interval '30 minutes'")
    log.info("Purged stale flights_live rows older than 30 min")


def log_run(cur, records_fetched, records_upserted, fetch_ms, upsert_ms,
            status="success", error=None):
    cur.execute("""
        INSERT INTO pipeline_runs
          (records_fetched, records_upserted, fetch_ms, upsert_ms, status, error_msg)
        VALUES (%s, %s, %s, %s, %s, %s)
    """, (records_fetched, records_upserted, fetch_ms, upsert_ms, status, error))


# ── Main loop ─────────────────────────────────────────────────────────────────

def run_once(conn) -> None:
    records_fetched = upserted = fetch_ms = upsert_ms = 0
    try:
        records, fetch_ms = fetch_opensky()
        records_fetched = len(records)

        if not records:
            log.warning("No records from OpenSky — skipping upsert")
            cur = conn.cursor()
            log_run(cur, 0, 0, fetch_ms, 0, "error", "Empty response from OpenSky")
            pass  # autocommit=True — no manual commit needed
            return

        all_flights = records

        # Airborne subset — used for history only (ground adds storage with no analytics value)
        airborne = [r for r in all_flights if not r['on_ground']]

        t0 = time.monotonic()
        upserted = upsert_live(all_flights)      # each chunk uses its own fresh connection
        upsert_ms = int((time.monotonic() - t0) * 1000)
        log.info(f"Upserted {upserted:,} records in {upsert_ms}ms")

        # Fresh connection for cleanup + logging (short-lived, won't hit timeout)
        conn = make_connection()
        cur = conn.cursor()
        purge_stale_live(cur)
        upsert_anomaly_hourly(cur)
        log_run(cur, records_fetched, upserted, fetch_ms, upsert_ms)
        pass  # autocommit=True — no manual commit needed
        conn.close()

    except Exception as e:
        try:
            pass  # autocommit=True — no rollback needed
        except Exception:
            pass
        log.error(f"Ingestion error: {e}", exc_info=True)
        # Re-raise connection errors so main() reconnects
        if isinstance(e, (pgdb.OperationalError, pgdb.InterfaceError)):
            raise
        try:
            cur = conn.cursor()
            log_run(cur, records_fetched, upserted, fetch_ms, upsert_ms, "error", str(e))
            pass  # autocommit=True — no manual commit needed
        except Exception:
            pass
        raise  # propagate so GitHub Actions marks the run as FAILED


def make_connection():
    """Connect to Supabase via transaction pooler using pg8000.
    Uses regex parsing instead of urllib so passwords with # work correctly
    (urllib treats # as a fragment delimiter and breaks the URL)."""
    log.info("Connecting to Supabase (pg8000 / transaction pooler)...")
    m = re.match(r'postgresql://([^:]+):(.+)@([^@:]+):(\d+)/([^?]+)', DATABASE_URL)
    if not m:
        raise RuntimeError("Cannot parse DATABASE_URL — check its format")
    user, password, host, port, database = m.groups()
    conn = pgdb.connect(
        host=host,
        port=int(port),
        database=database,
        user=user,
        password=urllib.parse.unquote(password),
        ssl_context=True,
    )
    conn.autocommit = True   # no explicit BEGIN/COMMIT — compatible with PgBouncer transaction mode
    log.info("Connected ✓")
    return conn


def main():
    log.info("FlightPulse Global — Ingestion starting (one-shot mode)")
    log.info("OAuth2 credentials: CLIENT_ID=%s", "SET" if OPENSKY_CLIENT_ID else "NOT SET — check .env.local")
    log.info("REST endpoint: %s", SUPABASE_REST_URL or "NOT DERIVED — check DATABASE_URL format")
    log.info("Service key: %s", "SET" if SUPABASE_SERVICE_KEY else "NOT SET — add SUPABASE_SERVICE_KEY secret")
    if not SUPABASE_REST_URL or not SUPABASE_SERVICE_KEY:
        log.error("Missing Supabase credentials — ingestion cannot run")
        raise SystemExit(1)

    conn = make_connection()
    try:
        run_once(conn)

        # Purge pipeline_runs older than 3 days (cheap — runs on every cycle, near-instant if nothing to delete)
        try:
            cur = conn.cursor()
            cur.execute("SELECT purge_old_pipeline_runs()")
            pass  # autocommit=True — no manual commit needed
        except Exception as e:
            log.warning(f"pipeline_runs purge failed: {e}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
