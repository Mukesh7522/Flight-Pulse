"""
FlightPulse Global — OpenSky → Supabase Ingestion Script
=========================================================
Run: python ingestion/fetch_flights.py   (one-shot; triggered every ~2 min)

Each run:
  1. Fetch all live flight states from OpenSky Network
  2. Validate + clean the data
  3. Upsert into `flights_live` via the Supabase REST API (chunks of 1000)
  4. Purge flights_live rows not seen in 30 minutes
  5. Update the hourly anomaly counts
  6. Log the run to `pipeline_runs`

Triggers: cron-job.org → GitHub workflow_dispatch (primary), plus the workflow's
own schedule/push triggers. See "Operations" in README.md.
"""

import os
import sys
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

# ── Failure reporting ─────────────────────────────────────────────────────────
# GitHub shows "::error::" lines as public run ANNOTATIONS (readable via the API without
# logging in), so the cause of a failed run is visible without opening the raw log.
_SECRET_ENV = ("DATABASE_URL", "SUPABASE_SERVICE_KEY", "OPENSKY_CLIENT_ID", "OPENSKY_CLIENT_SECRET")


def redact(text: str) -> str:
    """Remove anything that looks like a credential before it is printed."""
    text = str(text)
    for name in _SECRET_ENV:
        val = os.environ.get(name, "")
        if len(val) >= 6:
            text = text.replace(val, f"<{name}>")
    # the database password on its own (it can appear without the rest of the URL)
    m = re.match(r"postgres(?:ql)?://[^:]+:(.+)@[^@]+$", os.environ.get("DATABASE_URL", ""))
    if m and len(m.group(1)) >= 4:
        text = text.replace(m.group(1), "<db-password>")
    text = re.sub(r"postgres(?:ql)?://\S+", "postgresql://<redacted>", text)
    text = re.sub(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]*", "<jwt>", text)
    text = re.sub(r"sb_(?:secret|publishable)_[A-Za-z0-9_\-]+", "<supabase-key>", text)
    return text


def emit_error(message: str) -> None:
    """Print a GitHub Actions error annotation (single line, credentials removed)."""
    cr, lf = chr(13), chr(10)
    one_line = redact(message).replace("%", "%25").replace(cr, "").replace(lf, "%0A")
    print(f"::error title=FlightPulse ingestion failed::{one_line}", flush=True)


def _excepthook(exc_type, exc, tb):
    emit_error(f"{exc_type.__name__}: {exc}")
    sys.__excepthook__(exc_type, exc, tb)


sys.excepthook = _excepthook

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

# OpenSky credit budget: a global /states/all call costs 4 credits. Standard accounts get
# 4,000 credits/day (= 1,000 calls), anonymous 400/day (= 100 calls). Several independent
# triggers (cron-job.org, GitHub schedule, watchdog) can fire this script, so the script
# itself enforces a minimum gap between OpenSky calls and extra triggers become no-ops.
# The gap is measured START-to-START: pipeline_runs.run_at is written at the END of a run, so
# the previous run's start is reconstructed as run_at - (fetch_ms + upsert_ms) - overhead. (Measuring
# from the end penalised slow runs: a 45 s upsert made the next 2-minute cron look "too soon".)
#   authenticated: >= 100 s -> <= 864 calls/day = 3,456 credits (< 4,000); a 2-min cron never skips
#   anonymous:     >= 900 s -> <= 96 calls/day  =   384 credits (< 400)
SLOW_UPSERT_MS = 45_000   # a successful upload slower than this halves the pace
RUN_OVERHEAD_S = 5   # connect / purge / log time outside fetch_ms + upsert_ms
MIN_INTERVAL_AUTH = int(os.environ.get("MIN_INTERVAL_AUTH", 100))
MIN_INTERVAL_ANON = int(os.environ.get("MIN_INTERVAL_ANON", 900))

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


class RateLimited(Exception):
    """OpenSky returned 429 (daily credit budget used up)."""
    def __init__(self, retry_after: int):
        super().__init__(f"OpenSky 429 retry_after={retry_after}")
        self.retry_after = retry_after


def seconds_until_allowed(cur, min_interval: int) -> float:
    """How long to wait before another OpenSky call / upload is allowed (0 = go ahead).
    Start-to-start spacing from the newest pipeline_runs rows, with BACKPRESSURE so a struggling
    database gets breathing room:
      - after a 429, honour the logged retry_after
      - each consecutive failed run doubles the gap (x2, x4, x8 = max ~13 min at 100 s base)
      - if the last successful upload was very slow (> 45 s), double the gap
    """
    cur.execute("SELECT EXTRACT(EPOCH FROM (now() - run_at)), status, error_msg, fetch_ms, upsert_ms "
                "FROM pipeline_runs ORDER BY run_at DESC LIMIT 6")
    rows = cur.fetchall()
    if not rows:
        return 0.0
    age_since_end, status, err = float(rows[0][0]), rows[0][1], rows[0][2] or ""
    duration_s = ((rows[0][3] or 0) + (rows[0][4] or 0)) / 1000.0 + RUN_OVERHEAD_S
    age_since_start = age_since_end + duration_s

    interval = min_interval
    streak = 0
    for r in rows:
        if r[1] == "error" and "retry_after=" not in (r[2] or ""):
            streak += 1
        else:
            break
    if streak:
        interval = min_interval * (2 ** min(streak, 3))
    elif status == "success" and (rows[0][4] or 0) > SLOW_UPSERT_MS:
        interval = min_interval * 2

    wait = interval - age_since_start
    m = re.search(r"retry_after=(\d+)", err) if status == "error" else None
    if m:
        wait = max(wait, int(m.group(1)) - age_since_end)
    return max(0.0, wait)


def fetch_opensky() -> tuple[list[dict], int]:
    """Fetch all live flights from OpenSky. Returns (records, latency_ms)."""
    t0    = time.monotonic()
    token = get_opensky_token()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    if not token:
        log.warning("No OAuth2 token — using anonymous request (low rate limit)")
    resp = None
    for attempt in (1, 2):   # one retry on timeout / connection error / 5xx
        try:
            resp = requests.get(OPENSKY_URL, headers=headers, timeout=OPENSKY_TIMEOUT)
            if resp.status_code < 500:
                break
            log.warning("OpenSky HTTP %d (attempt %d/2)", resp.status_code, attempt)
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            log.warning("OpenSky request failed (attempt %d/2): %s", attempt, type(e).__name__)
            resp = None
        if attempt == 1:
            time.sleep(5)
    if resp is None:
        fetch_ms = int((time.monotonic() - t0) * 1000)
        log.warning("OpenSky unreachable after retry — IP may be blocked, skipping run")
        return [], fetch_ms
    if resp.status_code == 429:
        retry_after = int(resp.headers.get("X-Rate-Limit-Retry-After-Seconds")
                          or resp.headers.get("Retry-After") or 3600)
        log.warning("OpenSky 429: daily credit budget used up, retry in %ds", retry_after)
        raise RateLimited(retry_after)
    resp.raise_for_status()
    log.info("OpenSky credits remaining: %s", resp.headers.get("X-Rate-Limit-Remaining", "unknown"))
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
    # Consistent row order -> consistent lock order, so concurrent runs / a cleanup DELETE
    # cannot deadlock each other on the same rows.
    records = sorted(records, key=lambda r: r["icao24"])
    for i in range(0, len(records), CHUNK):
        chunk = [{**r, "ingested_at": now_iso} for r in records[i:i + CHUNK]]
        post_with_retry(url, headers, chunk)
        log.info("HTTP upserted rows %d–%d", i + 1, min(i + CHUNK, len(records)))
    return len(records)


# Seconds to wait before retry 2 and 3 of a chunk. The upsert is idempotent
# (merge-duplicates), so repeating a chunk is always safe.
RETRY_DELAYS = (2, 6)

MAX_RUN_SECONDS = 240          # abort the upload if the run has taken this long (job limit is 5 min)
REQUEST_TIMEOUT = 30           # per upload request
_RUN_T0 = time.monotonic()


class DatabaseOverloaded(Exception):
    """Supabase is timing out or answering 502/503/504: stop adding load and try next cycle."""


def post_with_retry(url, headers, chunk):
    """POST one chunk. Retries only failures where the server ANSWERED with a transient error
    (500, 408, 429) or refused the connection - the chunk was not applied, so repeating is safe.
    A TIMEOUT or a gateway error (502/503/504) means the database is overloaded and may still be
    executing the request: retrying would stack duplicate heavy work on it, so we stop instead.
    Permanent client errors (400/401/403/404/422...) are raised immediately."""
    attempts = len(RETRY_DELAYS) + 1
    for attempt in range(1, attempts + 1):
        if time.monotonic() - _RUN_T0 > MAX_RUN_SECONDS:
            raise DatabaseOverloaded(f"run deadline of {MAX_RUN_SECONDS}s exceeded")
        try:
            resp = requests.post(url, headers=headers, json=chunk, timeout=REQUEST_TIMEOUT)
        except requests.exceptions.Timeout:
            raise DatabaseOverloaded("upload request timed out")
        except requests.exceptions.ConnectionError as e:
            if attempt == attempts:
                raise
            log.warning("Upsert connection error (attempt %d/%d) - retrying", attempt, attempts)
            time.sleep(RETRY_DELAYS[attempt - 1])
            continue
        if resp.status_code < 400:
            return
        if resp.status_code in (502, 503, 504):
            raise DatabaseOverloaded(f"Supabase answered HTTP {resp.status_code}")
        transient = resp.status_code in (500, 408, 429)
        if not transient or attempt == attempts:
            resp.raise_for_status()
        log.warning("Supabase HTTP %d on upsert (attempt %d/%d) - retrying", resp.status_code, attempt, attempts)
        time.sleep(RETRY_DELAYS[attempt - 1])


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
    """Apply the retention rules (flights_live 15 min, pipeline_runs 3 days, anomaly_hourly 25 h).
    Uses the database function public.purge_retention() (supabase/retention.sql); if it has not been
    installed yet, falls back to the same deletes inline so cleanup can never silently stop."""
    try:
        cur.execute("SELECT public.purge_retention()")
        log.info("Retention applied (purge_retention)")
    except Exception as e:
        log.warning("purge_retention() unavailable (%s) - using inline deletes", type(e).__name__)
        cur.execute("DELETE FROM flights_live WHERE ingested_at < now() - interval '15 minutes'")
        log.info("Purged flights_live rows older than 15 min (inline)")


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

    except RateLimited as e:
        log.warning("Skipping run: %s", e)
        try:
            log_run(conn.cursor(), 0, 0, fetch_ms, 0, "error", str(e))
        except Exception:
            pass
        return   # not a crash: next triggers will no-op until retry_after has passed
    except DatabaseOverloaded as e:
        # Supabase is struggling: do not add load, do not crash. Log the cycle (backpressure in
        # seconds_until_allowed() widens the gap) and let /api/health + UptimeRobot do the alerting.
        log.error("Database overloaded - skipping this cycle: %s", e)
        try:
            log_run(conn.cursor(), records_fetched, upserted, fetch_ms, upsert_ms, "error", f"database overloaded: {e}")
        except Exception:
            pass
        return
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
        timeout=20,            # never hang on a stuck database (was: wait until GitHub killed the job)
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
        problems = []
        if not SUPABASE_REST_URL:
            problems.append("cannot derive the Supabase project URL from the DATABASE_URL secret (empty, or not a valid Supabase connection string)")
        if not SUPABASE_SERVICE_KEY:
            problems.append("SUPABASE_SERVICE_KEY secret is empty or missing")
        log.error("Missing Supabase credentials — ingestion cannot run")
        emit_error("Missing credentials: " + "; ".join(problems) + ". Check GitHub repo Settings > Secrets and variables > Actions.")
        raise SystemExit(1)

    try:
        conn = make_connection()
    except (OSError, pgdb.Error) as e:
        # Database unreachable / timing out: this is an outage to be ALERTED on (/api/health, UptimeRobot),
        # not a crash to email on every 2-minute cycle. Skip quietly; the next cycle probes again.
        log.error("Database unreachable (%s: %s) - skipping this cycle", type(e).__name__, e)
        return
    try:
        # Protect the OpenSky credit budget (see MIN_INTERVAL_* above)
        authenticated = get_opensky_token() is not None
        min_interval = MIN_INTERVAL_AUTH if authenticated else MIN_INTERVAL_ANON
        try:
            wait = seconds_until_allowed(conn.cursor(), min_interval)
        except (OSError, pgdb.Error) as e:
            # Connected, but the database cannot even answer a tiny query: it is overloaded.
            log.error("Database too slow to read the run log (%s: %s) - skipping this cycle", type(e).__name__, e)
            return
        if wait > 0:
            log.info("Skipping: last OpenSky call was too recent (%s mode, min gap %ds, wait %ds more) — "
                     "protecting the daily credit budget", "authenticated" if authenticated else "ANONYMOUS",
                     min_interval, int(wait))
            return
        if not authenticated:
            log.warning("Running ANONYMOUS (400 credits/day): refresh limited to every %ds. "
                        "Check OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET secrets.", MIN_INTERVAL_ANON)

        try:
            run_once(conn)
        except (OSError, pgdb.Error) as e:
            log.error("Database connection problem during the run (%s: %s) - skipping this cycle", type(e).__name__, e)
            return

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
    try:
        main()
    except SystemExit as e:
        if e.code not in (0, None):
            emit_error(f"exited with code {e.code}")
        raise
