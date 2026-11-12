"""One HTTP request. No redirects/retries; the Node caller owns the budget."""
import base64
import json
import sys

import curl_cffi
from curl_cffi import requests

args = json.load(sys.stdin)
chunks = []
size = 0


def receive(chunk):
    global size
    size += len(chunk)
    if size > 5 * 1024 * 1024:
        raise ValueError("Response exceeds 5 MiB")
    chunks.append(chunk)
    return len(chunk)


try:
    with requests.Session(trust_env=False) as session:
        response = session.get(
            args["url"], impersonate="chrome136",
            default_headers=args["profile"] == "cffi-chrome",
            headers=args.get("headers") or None,
            allow_redirects=False, timeout=20, content_callback=receive,
        )
        print(json.dumps({
            "status": response.status_code,
            "headers": dict(response.headers),
            "body": base64.b64encode(b"".join(chunks)).decode("ascii"),
            "version": curl_cffi.__version__, "impersonate": "chrome136",
            "httpVersion": response.http_version,
        }))
except Exception as error:
    print(json.dumps({"error": str(error), "version": curl_cffi.__version__}))
