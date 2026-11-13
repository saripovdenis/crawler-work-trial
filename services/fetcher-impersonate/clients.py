"""Only HTTP boundary for the Python worker. No implicit redirects or retries."""
import hashlib
import json
import os
import re
from urllib.parse import urlsplit

from curl_cffi import CurlOpt, requests

from runtime import MAX_RESPONSE_BYTES, now_ms, timestamp, utc_now


def validate_profile(profile):
    if (not isinstance(profile, dict) or profile.get("impersonate") != "chrome136"
            or not isinstance(profile.get("defaultHeaders"), bool)
            or not isinstance(profile.get("headers"), dict)):
        raise ValueError("Invalid fetch profile")
    for key, value in profile["headers"].items():
        if (not isinstance(key, str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9a-z-]+", key, re.I)
                or not isinstance(value, str) or "\r" in value or "\n" in value):
            raise ValueError("Invalid profile header")
    return profile


def publisher_request(url, profile, headers, start_by=None, on_start=None):
    validate_profile(profile)
    chunks, size, oversized = [], 0, False

    def receive(chunk):
        nonlocal size, oversized
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            oversized = True
            return 0
        chunks.append(chunk)
        return len(chunk)

    # Each request has a fresh cookie/connection context, as with the old subprocess.
    with requests.Session(trust_env=False) as session:
        if start_by and now_ms() > timestamp(start_by):
            raise ValueError("Dispatch deadline expired")
        if on_start:
            on_start()
        try:
            response = session.get(url, impersonate=profile["impersonate"],
                                   default_headers=profile["defaultHeaders"],
                                   headers={**profile["headers"], **headers}, allow_redirects=False,
                                   timeout=20, content_callback=receive)
        except Exception:
            if oversized:
                raise ValueError("Response exceeds 5 MiB") from None
            raise
        finished = utc_now()
        if not 200 <= response.status_code <= 599:
            raise ValueError("Invalid HTTP response status")
        return {"status": response.status_code, "headers": {key.lower(): value for key, value in response.headers.items()},
                "body": b"" if response.status_code in (204, 205, 304) else b"".join(chunks),
                "fetch_finished_at": finished, "httpVersion": int(response.http_version)}


def loopback_url(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.username
            or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("Endpoint must be loopback HTTP with no path or credentials")
    return value.rstrip("/")


class SchedulerClient:
    def __init__(self, url):
        self.url = loopback_url(url)

    def request(self, method, path, value=None):
        if path not in ("/internal/worker-config", "/internal/claims") and not re.fullmatch(
                r"/internal/attempts/[\w-]+/complete", path):
            raise ValueError("Invalid scheduler path")
        chunks, size = [], 0

        def receive(chunk):
            nonlocal size
            size += len(chunk)
            if size > 256 * 1024:
                return 0
            chunks.append(chunk)
            return len(chunk)

        with requests.Session(trust_env=False) as session:
            response = session.request(method, self.url + path, json=value, timeout=5,
                                       allow_redirects=False, content_callback=receive)
        if not 200 <= response.status_code < 300:
            raise RuntimeError(f"Scheduler HTTP {response.status_code}")
        result = json.loads(b"".join(chunks))
        if not isinstance(result, dict):
            raise ValueError("Invalid scheduler response")
        return result


class StorageClient:
    def __init__(self):
        self.url = loopback_url(os.environ.get("ARCHIVE_S3_ENDPOINT", "http://127.0.0.1:3900"))
        self.bucket = os.environ.get("ARCHIVE_S3_BUCKET", "response-archive")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", self.bucket):
            raise ValueError("Invalid archive bucket")
        access, secret = os.environ.get("ARCHIVE_S3_ACCESS_KEY"), os.environ.get("ARCHIVE_S3_SECRET_KEY")
        region = os.environ.get("ARCHIVE_S3_REGION", "garage")
        if not access or not secret:
            raise ValueError("Missing storage credentials")
        if not re.fullmatch(r"[a-z0-9-]+", region):
            raise ValueError("Invalid storage region")
        self.options = {CurlOpt.AWS_SIGV4: f"aws:amz:{region}:s3", CurlOpt.USERPWD: f"{access}:{secret}"}

    def put(self, digest, body):
        if not re.fullmatch(r"[a-f0-9]{64}", digest) or len(body) > MAX_RESPONSE_BYTES + 65536:
            raise ValueError("Invalid archive upload")
        # libcurl signs the fixed loopback PUT; no S3 redirect discovery or extra SDK requests.
        with requests.Session(trust_env=False, curl_options=self.options) as session:
            response = session.put(f"{self.url}/{self.bucket}/snapshots/{digest}.gz", data=body,
                                   headers={"Content-Type": "application/gzip", "x-amz-meta-sha256": digest,
                                            "x-amz-content-sha256": hashlib.sha256(body).hexdigest()},
                                   timeout=5, allow_redirects=False)
        if not 200 <= response.status_code < 300:
            raise RuntimeError(f"Storage HTTP {response.status_code}")
