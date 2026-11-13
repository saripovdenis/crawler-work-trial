"""Legacy one-request diagnostic CLI; the production worker calls the same client in process."""
import base64
import json
import sys

import curl_cffi

from clients import publisher_request

try:
    args = json.load(sys.stdin)
    profile = args["profile"]
    if isinstance(profile, str):
        if profile not in ("cffi-chrome", "cffi-crawler"):
            raise ValueError("Unknown fetch profile")
        profile = {"impersonate": "chrome136", "defaultHeaders": profile == "cffi-chrome", "headers": {}}
    response = publisher_request(args["url"], profile, args.get("headers") or {}, args.get("start_by"))
    response["body"] = base64.b64encode(response["body"]).decode("ascii")
    print(json.dumps({**response, "version": curl_cffi.__version__, "impersonate": profile["impersonate"]}))
except Exception as error:
    print(json.dumps({"error": str(error), "version": curl_cffi.__version__}))
