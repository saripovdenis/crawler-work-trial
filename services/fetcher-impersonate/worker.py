"""Durable Python fetch worker. The Node scheduler owns the ledger and all policy."""
import argparse
import json
import os
import re
import signal
import sys
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from archives import ArchiveStore, decompress
from clients import SchedulerClient, publisher_request, validate_profile
from mirror import ArchiveMirror
from runtime import (DISPATCH_MS, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, WorkerLock,
                     atomic_write, elapsed, now_ms, timestamp, timing, utc_now, write_json)


def validate_configuration(value):
    if value.get("version") != 1 or value.get("limits") != {
            "timeout_ms": REQUEST_TIMEOUT_MS, "max_response_bytes": MAX_RESPONSE_BYTES, "dispatch_ms": DISPATCH_MS}:
        raise ValueError("Unsupported scheduler worker configuration")
    sites = value.get("sites")
    if not isinstance(sites, list) or not sites:
        raise ValueError("Missing site policy")
    domains = set()
    for site in sites:
        domain = site.get("domain", "")
        if (not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]+", domain)
                or type(site.get("enabled")) is not bool or domain in domains):
            raise ValueError("Invalid scheduler site policy")
        if any(domain.endswith("." + other) or other.endswith("." + domain) for other in domains):
            raise ValueError("Overlapping scheduler domains")
        domains.add(domain)
    for key in ("node", "chrome136"):
        validate_profile(value["legacy_profiles"][key])
    return value


def assignment_profile(task, config):
    if task.get("timeout_ms") != REQUEST_TIMEOUT_MS or task.get("max_response_bytes") != MAX_RESPONSE_BYTES:
        raise ValueError("Unsupported assignment limits")
    url = urlsplit(task["url"])
    if (url.scheme not in ("http", "https") or url.username or url.password
            or url.port not in (None, 80, 443)):
        raise ValueError("Site policy does not allow this request")
    site = next((site for site in config["sites"] if url.hostname == site["domain"]
                 or (url.hostname or "").endswith("." + site["domain"])), None)
    if not site or not site["enabled"] or site["domain"] != task["domain"]:
        raise ValueError("Site policy does not allow this request")
    transport = task.get("transport")
    if transport == "curl_cffi":
        return validate_profile(task.get("fetch_profile"))
    if transport not in ("node", "chrome136"):
        raise ValueError("Unsupported assignment transport")
    return config["legacy_profiles"][transport]


def empty_completion(task, error=None):
    return dict(lease_token=task["lease_token"], started_at=None, finished_at=utc_now(), status=None,
                headers={}, body_hash=None, response_ref=None, bytes=0, error=error)


def execute(task, store, config):
    result = empty_completion(task)
    start = phase_start = time.monotonic()
    phase, durations, reused = "dispatch", {}, None

    def next_phase(name):
        nonlocal phase, phase_start
        durations[phase + "_ms"] = elapsed(phase_start)
        phase, phase_start = name, time.monotonic()

    def on_start():
        started = utc_now()
        if timestamp(started) > timestamp(task["start_by"]):
            raise ValueError("Dispatch deadline expired")
        result["started_at"] = started
        next_phase("response_wait")

    try:
        profile = assignment_profile(task, config)
        response = publisher_request(task["url"], profile, task["headers"], task["start_by"], on_start)
        result.update(status=response["status"], headers=response["headers"], fetch_finished_at=response["fetch_finished_at"])
        next_phase("decode_hash")
        body = response["body"]
        if body.startswith(b"\x1f\x8b"):
            body = decompress(body)
        next_phase("archive_store")
        digest, ref, reused = store.store(body)
        result.update(body_hash=digest, response_ref=ref, bytes=len(body))
    except Exception as error:
        result["error"] = str(error)[:4096]
    result["finished_at"] = utc_now()
    durations[phase + "_ms"] = elapsed(phase_start)
    timing("fetch", attempt_id=task["attempt_id"], task_id=task["task_id"], domain=task["domain"],
           purpose=task["purpose"], transport="curl_cffi", status=result["status"], failed=result["error"] is not None,
           failed_phase=phase if result["error"] else None,
           dispatch_wait_ms=timestamp(result["started_at"]) - (timestamp(task["start_by"]) - DISPATCH_MS) if result["started_at"] else None,
           response_wait_scope="python_full_response", **durations, total_ms=elapsed(start),
           bytes=result["bytes"], archive_reused=reused)
    return result


def save_receipt(path, receipt, phase):
    start, written = time.monotonic(), False
    try:
        write_json(path, receipt)
        written = True
    finally:
        timing("receipt_write", attempt_id=receipt.get("task", {}).get("attempt_id"),
               claim_id=receipt["claim_id"], phase=phase, written=written, durable_write_ms=elapsed(start))


def run_slot(slot, directory, worker_id, client, store, config, mirror, concurrency, stop):
    path = directory / "receipts" / (str(slot) + ".json")
    recovery_only = slot >= concurrency
    while not stop.is_set():
        if recovery_only and not path.exists():
            return
        try:
            receipt = json.loads(path.read_text()) if path.exists() else {"claim_id": str(uuid.uuid4())}
            save_receipt(path, receipt, "before_claim")
            if not receipt.get("task"):
                if stop.is_set():
                    return
                start, claim = time.monotonic(), None
                try:
                    claim = client.request("POST", "/internal/claims", {"worker_id": worker_id, "claim_id": receipt["claim_id"]})
                finally:
                    if claim is None or claim.get("task") or elapsed(start) >= 1000:
                        timing("claim_client", claim_id=receipt["claim_id"],
                               attempt_id=(claim.get("task") or {}).get("attempt_id") if claim else None,
                               roundtrip_ms=elapsed(start), assigned=bool(claim and claim.get("task")), failed=claim is None)
                if not claim.get("task"):
                    path.unlink()
                    stop.wait(max(0.001, float(claim.get("retry_after_ms") or 1000) / 1000))
                    continue
                receipt["task"] = claim["task"]
                save_receipt(path, receipt, "assigned")
            task = receipt["task"]
            # Drain accepted claims even when SIGTERM arrived during the claim.
            # Saving an unsent assignment for restart lets its start_by expire.
            # The loop condition prevents another claim after this completion;
            # execute still enforces the original dispatch deadline and budget.
            if not receipt.get("completion"):
                if receipt.get("dispatched"):
                    # A killed worker may have sent it. Never repeat that HTTP request.
                    if now_ms() < timestamp(task["lease_until"]):
                        stop.wait(1)
                        continue
                    receipt["completion"] = empty_completion(task, "Worker restarted; outcome unknown")
                else:
                    receipt["dispatched"] = True
                    save_receipt(path, receipt, "before_dispatch")
                    receipt["completion"] = execute(task, store, config)
                save_receipt(path, receipt, "completed")
            completion = receipt["completion"]
            if mirror and completion.get("body_hash"):
                try:
                    mirror.enqueue(completion["body_hash"])
                except Exception as error:
                    print("Could not enqueue optional archive mirror:", str(error), file=sys.stderr, flush=True)
            start, acknowledged = time.monotonic(), False
            try:
                response = client.request("POST", f'/internal/attempts/{task["attempt_id"]}/complete', completion)
                if response.get("outcome") not in ("completed", "expired"):
                    raise ValueError("Invalid completion acknowledgement")
                acknowledged = True
            finally:
                timing("complete_client", attempt_id=task["attempt_id"], acknowledged=acknowledged, roundtrip_ms=elapsed(start))
            path.unlink()
        except Exception as error:
            print("Worker will retry receipt:", str(error), file=sys.stderr, flush=True)
            stop.wait(1)


def run(directory, scheduler_url, concurrency, stop):
    if not 1 <= concurrency <= 20:
        raise ValueError("Invalid concurrency")
    receipts = directory / "receipts"
    receipts.mkdir(parents=True, exist_ok=True)
    lock = WorkerLock(receipts)
    mirror, threads = None, []
    store = ArchiveStore(directory)
    metrics_path = receipts / "archive-cache-metrics.json"

    def report():
        try:
            with store.lock:
                write_json(metrics_path, {"generatedAt": now_ms(), **store.metrics})
        except Exception as error:
            print("Archive metrics:", str(error), file=sys.stderr, flush=True)

    try:
        client = SchedulerClient(scheduler_url)
        config = None
        while not stop.is_set() and config is None:
            try:
                config = validate_configuration(client.request("GET", "/internal/worker-config"))
            except Exception as error:
                print("Waiting for scheduler configuration:", str(error), file=sys.stderr, flush=True)
                stop.wait(5)
        if config is None:
            return
        try:
            previous = json.loads(metrics_path.read_text())
            for key in store.metrics:
                if type(previous.get(key)) is int and previous[key] >= 0:
                    store.metrics[key] = previous[key]
        except (OSError, ValueError):
            pass
        identity = receipts / "worker-id"
        if not identity.exists():
            atomic_write(identity, str(uuid.uuid4()))
        worker_id = identity.read_text()
        if os.environ.get("ARCHIVE_MIRROR") == "1":
            mirror = ArchiveMirror(directory, store)
        slots = set(range(concurrency)) | {int(path.stem) for path in receipts.glob("*.json") if path.stem.isdigit()}
        for slot in sorted(slots):
            thread = threading.Thread(target=run_slot, name=f"fetch-{slot}",
                                      args=(slot, directory, worker_id, client, store, config, mirror, concurrency, stop))
            thread.start()
            threads.append(thread)
        print(f"Python fetch worker started ({concurrency} slots)", flush=True)
        while not stop.wait(30):
            report()
    finally:
        stop.set()
        for thread in threads:
            thread.join()
        if mirror:
            mirror.close()
        report()
        lock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check imports and runtime; no network or file writes")
    args = parser.parse_args()
    if args.check:
        print("Python fetch worker imports OK")
        return
    stop = threading.Event()
    for event in (signal.SIGTERM, signal.SIGINT):
        signal.signal(event, lambda *_: stop.set())
    run(Path(os.environ.get("CRAWLER_DATA_DIR", "data")).resolve(),
        os.environ.get("SCHEDULER_URL", "http://127.0.0.1:4319"), int(os.environ.get("FETCH_CONCURRENCY", "4")), stop)


if __name__ == "__main__":
    main()
