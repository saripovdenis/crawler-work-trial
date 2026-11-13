"""Optional background archive uploads; markers survive worker restarts."""
import json
import re
import sys
import threading
import time

from clients import StorageClient
from runtime import elapsed, now_ms, write_json


class ArchiveMirror:
    def __init__(self, directory, store):
        self.root = directory / "receipts" / "archive-mirror"
        for child in ("pending", "uploaded"):
            (self.root / child).mkdir(parents=True, exist_ok=True)
        self.store = store
        self.path = directory / "receipts" / "archive-mirror-metrics.json"
        self.metrics = dict(startedAt=now_ms(), uploaded=0, uploadBytes=0, errors=0, lastError=None,
                            lastUploadedAt=None, lastUploadMs=0, totalUploadMs=0, maxUploadMs=0,
                            pending=0, oldestPendingAt=None)
        try:
            previous = json.loads(self.path.read_text())
            self.metrics.update({key: previous[key] for key in self.metrics if key in previous})
        except (OSError, ValueError):
            pass
        self.metrics["uploaded"] = len(list((self.root / "uploaded").glob("*.json")))
        self.stopped, self.wake, self.lock = threading.Event(), threading.Event(), threading.Lock()
        self.retry_at, self.failures, self.client = 0, 0, None
        self.thread = threading.Thread(target=self.run, name="archive-mirror")
        self.thread.start()

    def enqueue(self, digest):
        if not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("Invalid mirror hash")
        with self.lock:
            if (self.root / "uploaded" / (digest + ".json")).exists():
                return
            pending = self.root / "pending" / (digest + ".json")
            if not pending.exists():
                write_json(pending, {"hash": digest, "queuedAt": now_ms()})
        self.wake.set()

    def report(self):
        write_json(self.path, {**self.metrics, "generatedAt": now_ms(), "retryAt": self.retry_at})

    def pump(self):
        pending = []
        for path in (self.root / "pending").glob("*.json"):
            if re.fullmatch(r"[a-f0-9]{64}", path.stem):
                pending.append((path, json.loads(path.read_text())))
        pending.sort(key=lambda item: item[1]["queuedAt"])
        self.metrics["pending"] = len(pending)
        self.metrics["oldestPendingAt"] = pending[0][1]["queuedAt"] if pending else None
        if now_ms() < self.retry_at:
            return
        for path, item in pending[:20]:
            if self.stopped.is_set():
                break
            digest = path.stem
            done = self.root / "uploaded" / path.name
            if not done.exists():
                compressed = self.store.read_compressed(digest)
                self.client = self.client or StorageClient()
                start = time.monotonic()
                self.client.put(digest, compressed)
                duration, uploaded = elapsed(start), now_ms()
                write_json(done, {"hash": digest, "queuedAt": item["queuedAt"], "uploadedAt": uploaded,
                                  "bytes": len(compressed), "uploadMs": duration})
                self.metrics["uploaded"] += 1
                self.metrics["uploadBytes"] += len(compressed)
                self.metrics["lastUploadMs"] = duration
                self.metrics["totalUploadMs"] += duration
                self.metrics["maxUploadMs"] = max(self.metrics["maxUploadMs"], duration)
                self.metrics["lastUploadedAt"] = uploaded
            path.unlink()
            self.metrics["pending"] -= 1
            self.failures, self.retry_at, self.metrics["lastError"] = 0, 0, None

    def run(self):
        while not self.stopped.is_set():
            self.wake.clear()
            try:
                self.pump()
            except Exception as error:
                self.failures += 1
                self.metrics["errors"] += 1
                self.metrics["lastError"] = str(error)[:4096]
                self.retry_at = now_ms() + min(60000, 1000 * 2 ** min(self.failures, 6))
            finally:
                if self.metrics["pending"] == 0:
                    self.metrics["oldestPendingAt"] = None
                try:
                    self.report()
                except Exception as error:
                    print("Archive mirror metrics:", str(error), file=sys.stderr, flush=True)
            self.wake.wait(2)

    def close(self):
        self.stopped.set()
        self.wake.set()
        self.thread.join()
