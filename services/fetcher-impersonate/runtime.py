"""File-only worker state, compatible with the previous Node receipts."""
import fcntl
import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

MAX_RESPONSE_BYTES = 5 * 1024 * 1024
REQUEST_TIMEOUT_MS = 20_000
DISPATCH_MS = 5_000


def now_ms():
    return time.time_ns() // 1_000_000


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamp must include a timezone")
    return parsed.timestamp() * 1000


def elapsed(start):
    return round((time.monotonic() - start) * 1000, 2)


def timing(stage, **fields):
    if os.environ.get("CRAWLER_TIMING_LOGS") == "1":
        try:
            print(json.dumps({"event": "crawler_timing", "at": utc_now(), "stage": stage, **fields}), flush=True)
        except (OSError, ValueError):
            pass


def atomic_write(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + "." + str(uuid.uuid4()) + ".tmp")
    data = value.encode() if isinstance(value, str) else value
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)


def write_json(path, value):
    atomic_write(path, json.dumps(value, separators=(",", ":"), allow_nan=False))


class WorkerLock:
    def __init__(self, directory):
        self.path = directory / "fetch-worker.pid"
        # A stable flock serializes Python starts; the old PID file also excludes Node workers.
        self.guard = open(directory / "fetch-worker.lock", "a")
        try:
            fcntl.flock(self.guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if self.path.exists():
                pid = int(self.path.read_text())
                if pid <= 0:
                    raise RuntimeError("Invalid existing worker PID")
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    self.path.unlink()
                else:
                    raise RuntimeError("A fetch worker is already running")
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as output:
                output.write(str(os.getpid()))
                output.flush()
                os.fsync(output.fileno())
        except BaseException:
            self.guard.close()
            raise

    def close(self):
        try:
            if self.path.read_text() == str(os.getpid()):
                self.path.unlink()
        finally:
            self.guard.close()
