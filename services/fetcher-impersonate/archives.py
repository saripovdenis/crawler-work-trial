"""Immutable gzip archives and a bounded verification cache; no network or database."""
import gzip
import hashlib
import io
import re
import stat
import threading
import zlib
from collections import OrderedDict

from runtime import MAX_RESPONSE_BYTES, atomic_write


def decompress(body):
    with gzip.GzipFile(fileobj=io.BytesIO(body)) as stream:
        decoded = stream.read(MAX_RESPONSE_BYTES + 1)
    if len(decoded) > MAX_RESPONSE_BYTES:
        raise ValueError("Response exceeds 5 MiB")
    return decoded


class ArchiveStore:
    def __init__(self, directory):
        self.directory = directory / "snapshots"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.verified = OrderedDict()
        self.lock = threading.RLock()
        self.metrics = dict(reused=0, written=0, repaired=0, avoidedBytes=0)

    def path(self, digest):
        if not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("Invalid body hash")
        return self.directory / (digest + ".gz")

    @staticmethod
    def signature(path):
        item = path.lstat()
        if not stat.S_ISREG(item.st_mode) or item.st_size > MAX_RESPONSE_BYTES + 65536:
            raise ValueError("Invalid archive file")
        return item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns

    def remember(self, digest, signature):
        self.verified[digest] = signature
        self.verified.move_to_end(digest)
        while len(self.verified) > 4096:
            self.verified.popitem(last=False)

    def read_compressed(self, digest):
        with self.lock:
            path = self.path(digest)
            self.signature(path)
            compressed = path.read_bytes()
            if hashlib.sha256(decompress(compressed)).hexdigest() != digest:
                raise ValueError("Archive integrity mismatch")
            return compressed

    def store(self, body):
        if len(body) > MAX_RESPONSE_BYTES:
            raise ValueError("Response exceeds 5 MiB")
        digest = hashlib.sha256(body).hexdigest()
        with self.lock:
            path = self.path(digest)
            try:
                signature = (*self.signature(path), len(body))
                if self.verified.get(digest) != signature:
                    decoded = decompress(path.read_bytes())
                    if len(decoded) != len(body) or hashlib.sha256(decoded).hexdigest() != digest:
                        raise ValueError("Archive integrity mismatch")
                self.remember(digest, signature)
                self.metrics["reused"] += 1
                self.metrics["avoidedBytes"] += len(body)
                return digest, f"snapshots/{digest}.gz", True
            except (OSError, ValueError, EOFError, zlib.error):
                self.verified.pop(digest, None)
            if path.exists() or path.is_symlink():
                self.metrics["repaired"] += 1
            atomic_write(path, gzip.compress(body, compresslevel=6, mtime=0))
            self.remember(digest, (*self.signature(path), len(body)))
            self.metrics["written"] += 1
            return digest, f"snapshots/{digest}.gz", False
