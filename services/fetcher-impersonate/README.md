# One-request transport

Python + curl_cffi, invoked by the crawler as a short-lived subprocess. No database,
limiter, scheduler, automatic redirects or retries. No daemon or listening port.
The crawler reserves the request in SQLite before invoking this executable.

Install from the repository root:

```sh
python3 -m venv .venv
.venv/bin/pip install -r services/fetcher-impersonate/requirements.txt
.venv/bin/python services/fetcher-impersonate/check-cffi.py
```

`check-cffi.py` uses a loopback fixture server only. `CRAWLER_PYTHON` remains the
crawler's Python executable setting; the diagnostic uses `PROBE_PYTHON` as before.

## Existing stdin/stdout contract

One JSON object on stdin; one JSON object on stdout; then exit:

```json
{"url":"https://hoodline.com/","profile":"cffi-chrome","headers":{"If-None-Match":"example"}}
```

- `url`: URL approved by the caller's domain and robots policy.
- `profile`: `cffi-chrome` enables default Chrome 136 headers; `cffi-crawler`
  disables defaults for diagnostics. Both retain the Chrome 136 network profile.
- `headers`: optional caller headers, including conditional request headers.

Success (including HTTP error statuses):

```json
{"status":200,"headers":{"content-type":"text/html"},"body":"PGh0bWw+","version":"0.17.0","impersonate":"chrome136","httpVersion":3}
```

`body` is base64 of decompressed response bytes; `httpVersion` is libcurl's enum,
not a human protocol number. The caller stores response headers and gzipped bytes
and decides whether to follow a redirect or retry. The response limit is 5 MiB;
the request timeout is 20 seconds and the Node subprocess deadline is 25 seconds.

Transport failure:

```json
{"error":"transport error text","version":"0.17.0"}
```

The caller records this as a failed, charged attempt. Stderr is diagnostic output,
not part of the JSON contract. This format and behavior are unchanged by the move.
