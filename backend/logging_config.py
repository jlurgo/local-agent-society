"""
Daily-rotating file logging for the backend, mirroring vortexia's
src/logger.js (see ../../vortexia/src/logger.js) so both halves of the
"always available" service keep a consistent 7-day log trail instead of an
unbounded backend.log.

Call setup_logging() once, as early as possible in main.py's import order.

LAS_BACKEND_LOG_DIR overrides the log directory. The test suite sets it
(tests/conftest.py) so an in-process TestClient never writes its fake
agents' warnings into the production backend/logs/backend.log.
"""

from __future__ import annotations

import logging
import os
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

LOG_DIR = Path(os.environ.get("LAS_BACKEND_LOG_DIR") or Path(__file__).resolve().parent / "logs")
LOG_FILE = LOG_DIR / "backend.log"
RETENTION_DAYS = 7

_configured = False


def setup_logging() -> logging.Logger:
    global _configured
    logger = logging.getLogger("las.backend")
    if _configured:
        return logger

    LOG_DIR.mkdir(parents=True, exist_ok=True)

    handler = TimedRotatingFileHandler(
        LOG_FILE, when="midnight", backupCount=RETENTION_DAYS, utc=True
    )
    handler.setFormatter(logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False

    _configured = True
    return logger


logger = setup_logging()
