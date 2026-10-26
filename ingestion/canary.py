"""
FlightPulse canary — proves the database login path still works BEFORE production finds out.

It runs the SAME code the ingestion uses (fetch_flights.make_connection(): pg8000 over TLS with
SCRAM-SHA-256(-PLUS) channel binding). On 2026-10-25 scramp 1.5.0 broke exactly this
path (AttributeError: module 'scramp' has no attribute 'make_channel_binding') and the pipeline was
down for ~11 hours; this canary fails loudly the same way, in CI, with a readable annotation.

  python ingestion/canary.py --local        # against a throw-away TLS Postgres (no secrets needed)
  python ingestion/canary.py --production   # against the real project (needs the repo secrets)

Local mode expects DATABASE_URL to point at that Postgres (pg8000's ssl_context=True encrypts but does
not verify the certificate, so a self-signed test certificate is fine).
"""
import argparse
import importlib.metadata as md
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--local", action="store_true")
    mode.add_argument("--production", action="store_true")
    args = ap.parse_args()

    import fetch_flights as ff   # reads DATABASE_URL; same module/code path as production

    def fail(msg: str) -> int:
        ff.emit_error(f"Canary ({'local TLS' if args.local else 'production'}): {msg}")
        print(f"CANARY FAILED: {ff.redact(msg)}")
        return 1

    versions = {p: md.version(p) for p in ("pg8000", "scramp", "requests")}
    print("Canary versions:", versions)

    try:
        conn = ff.make_connection()          # TLS + SCRAM(-PLUS), exactly as production
    except BaseException as e:               # AttributeError from a library break is BaseException-safe here
        return fail(f"database login crashed: {type(e).__name__}: {e} (versions {versions})")

    try:
        cur = conn.cursor()
        cur.execute("SELECT 1")
        if cur.fetchone()[0] != 1:
            return fail("SELECT 1 returned something else")

        cur.execute("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
        row = cur.fetchone()
        if not row or not row[0]:
            return fail("connection is NOT encrypted (pg_stat_ssl.ssl is false)")
        print("OK: encrypted connection, SELECT 1 works")

        if args.local:
            cur.execute("SELECT rolpassword LIKE 'SCRAM-SHA-256%%' FROM pg_authid WHERE rolname = 'postgres'")
            r = cur.fetchone()
            if not r or not r[0]:
                return fail("test server is not using SCRAM-SHA-256 (the path that broke in Oct 2026)")
            print("OK: server uses SCRAM-SHA-256 over TLS (channel-binding path exercised)")
        else:
            cur.execute("SELECT count(*) FROM pipeline_runs")
            print("OK: pipeline_runs readable, rows =", cur.fetchone()[0])
    except BaseException as e:
        return fail(f"query failed: {type(e).__name__}: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

    if args.production:
        # The REST upload path (service key) must also work, otherwise ingestion cannot write.
        import requests
        if not ff.SUPABASE_REST_URL or not ff.SUPABASE_SERVICE_KEY:
            return fail("DATABASE_URL / SUPABASE_SERVICE_KEY secret missing or unusable")
        try:
            r = requests.get(
                f"{ff.SUPABASE_REST_URL}/rest/v1/pipeline_runs?select=run_at&limit=1",
                headers={"apikey": ff.SUPABASE_SERVICE_KEY, "Authorization": f"Bearer {ff.SUPABASE_SERVICE_KEY}"},
                timeout=30,
            )
        except BaseException as e:
            return fail(f"REST API unreachable: {type(e).__name__}: {e}")
        if r.status_code != 200:
            return fail(f"REST API answered HTTP {r.status_code} with the service key (key rotated or revoked?)")
        print("OK: REST API accepts the service key")

    print("CANARY PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
