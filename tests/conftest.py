"""
Pytest plugin — updates docs/boarding.html with test results after each run.
Results are embedded as JSON inside <script id="las-test-results"> so the
HTML works as a static file:// with no network requests needed.

Also keeps the suite out of the production log: backend/logging_config.py
opens backend/logs/backend.log at import, and every test that imports
backend.main would otherwise leave its fake agents' TTS warnings there for
an operator to misread. The override must be in place before that first
import, hence at conftest import time.
"""
import json
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path

os.environ.setdefault("LAS_BACKEND_LOG_DIR", tempfile.mkdtemp(prefix="las-backend-test-logs-"))
# Importing backend/main.py must not start fetching GitHub in the background (backend/updates.py).
os.environ.setdefault("LAS_NO_UPDATE_CHECK", "1")

BOARDING_HTML = Path(__file__).parent.parent / "docs" / "boarding.html"
_MARKER = re.compile(
    r'(<script id="las-test-results" type="application/json">)(.*?)(</script>)',
    re.DOTALL,
)

# nodeid → call-phase report, populated by pytest_runtest_logreport
_reports: dict = {}


def pytest_runtest_logreport(report):
    if report.when == "call":
        _reports[report.nodeid] = report


def pytest_sessionfinish(session, exitstatus):
    tests = []
    passed = failed = skipped = 0

    for item in session.items:
        rep      = _reports.get(item.nodeid)
        outcome  = rep.outcome if rep else "passed"
        duration = float(getattr(rep, "duration", 0.0) or 0.0) if rep else 0.0
        longrepr = str(rep.longrepr) if (rep and rep.longrepr) else None

        if outcome == "passed":
            passed += 1
        elif outcome == "failed":
            failed += 1
        else:
            skipped += 1

        tests.append({
            "nodeid":   item.nodeid,
            "doc":      (item.function.__doc__ or "").strip() if hasattr(item, "function") else "",
            "outcome":  outcome,
            "duration": round(duration, 6),
            "longrepr": longrepr,
        })

    results = {
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "duration":  round(sum(t["duration"] for t in tests), 3),
        "total":     session.testscollected,
        "passed":    passed,
        "failed":    failed,
        "skipped":   skipped,
        "exit_code": int(exitstatus),
        "tests":     tests,
    }

    if not BOARDING_HTML.exists():
        return

    html     = BOARDING_HTML.read_text(encoding="utf-8")
    new_json = json.dumps(results, ensure_ascii=False)
    updated  = _MARKER.sub(lambda m: m.group(1) + new_json + m.group(3), html)

    if updated != html:
        BOARDING_HTML.write_text(updated, encoding="utf-8")
        print("\n  boarding.html updated → docs/boarding.html")
