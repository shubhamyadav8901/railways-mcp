"""Download TAG 2026 PDFs (1.pdf, 2.pdf, ... until 404) into data/raw/tag2026/.

Uses curl: the server's TLS setup fails the handshake with Python's default
OpenSSL context, while curl (system TLS) negotiates fine.
"""
import pathlib, subprocess, sys, time

BASE = "https://indianrailways.gov.in/railwayboard/uploads/directorate/coaching/TAG_2026/{n}.pdf"
OUT = pathlib.Path(__file__).resolve().parents[2] / "data" / "raw" / "tag2026"


def fetch(n: int, dest: pathlib.Path) -> int:
    tmp = dest.with_suffix(".part")
    r = subprocess.run(
        ["curl", "-sS", "--retry", "3", "-A", "railways-mcp TAG ETL", "-o", str(tmp),
         "-w", "%{http_code}", BASE.format(n=n)],
        capture_output=True, text=True, check=True)
    code = int(r.stdout.strip() or 0)
    if code == 200 and tmp.read_bytes()[:4] == b"%PDF":
        tmp.rename(dest)
    else:
        tmp.unlink(missing_ok=True)
    return code


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    n = 1
    while True:
        dest = OUT / f"{n}.pdf"
        if not (dest.exists() and dest.stat().st_size > 0):
            code = fetch(n, dest)
            if code == 404:
                print(f"{n}.pdf -> 404, stopping")
                break
            if not dest.exists():
                sys.exit(f"{n}.pdf: HTTP {code} / not a PDF; aborting")
            print(f"{n}.pdf {dest.stat().st_size} bytes", flush=True)
            time.sleep(0.5)
        n += 1


if __name__ == "__main__":
    main()
