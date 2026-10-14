"""
backend/logging_config.py — where the backend log lands.

Regression for 2026-10-14: every pytest run left "[tts] no widget picked up
speak … for 'Ghost'" and friends in the real backend/logs/backend.log,
because the in-process TestClient imports backend.main, which opens the
production log file at import. The suite now points LAS_BACKEND_LOG_DIR at
a temp dir (tests/conftest.py) and logging_config honors it.
"""
import importlib
import logging
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PRODUCTION_LOG_DIR = REPO / "backend" / "logs"


def _import_logging_config():
    sys.path.insert(0, str(REPO / "backend"))
    import logging_config
    return logging_config


def _reload_with_clean_logger(module):
    for handler in list(logging.getLogger("las.backend").handlers):
        logging.getLogger("las.backend").removeHandler(handler)
        handler.close()
    return importlib.reload(module)


def test_suite_never_writes_the_production_log():
    assert os.environ.get("LAS_BACKEND_LOG_DIR"), "conftest must set the override before any backend import"
    logging_config = _import_logging_config()
    assert logging_config.LOG_DIR == Path(os.environ["LAS_BACKEND_LOG_DIR"])
    assert logging_config.LOG_DIR.resolve() != PRODUCTION_LOG_DIR.resolve()


def test_env_override_is_honored_at_import(tmp_path, monkeypatch):
    logging_config = _import_logging_config()
    monkeypatch.setenv("LAS_BACKEND_LOG_DIR", str(tmp_path / "logs"))
    try:
        reloaded = _reload_with_clean_logger(logging_config)
        assert reloaded.LOG_DIR == tmp_path / "logs"
        reloaded.logger.info("hello from the test")
        for handler in reloaded.logger.handlers:
            handler.flush()
        assert "hello from the test" in (tmp_path / "logs" / "backend.log").read_text()
    finally:
        monkeypatch.undo()
        _reload_with_clean_logger(logging_config)   # back to the conftest dir for the rest of the suite
