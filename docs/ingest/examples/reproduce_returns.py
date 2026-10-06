#!/usr/bin/env python3
"""Offline Decimal audit of the two documented, valid portfolio snapshots.

This is an independent calculation aid, not a general Score or ingestion CLI.
It checks evidence hashes and compares calculations with frozen research output.
"""
import argparse
import csv
import hashlib
import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal, getcontext
from pathlib import Path

getcontext().prec = 50
ROOT = Path(__file__).resolve().parent
DAY = 86_400_000
ZERO, ONE = Decimal(0), Decimal(1)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def iso(ms):
    return (datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=ms)).isoformat(
        timespec="milliseconds").replace("+00:00", "Z")


def close(actual, expected):
    return abs(actual - expected) <= Decimal("0.01") + Decimal("1e-9") * abs(expected)


def window_points(window):
    av, pnl = window["accountValueHistory"], window["pnlHistory"]
    require(len(av) == len(pnl) and len(av) >= 2, "Invalid series lengths")
    points = []
    for (ts, equity), (pnl_ts, cumulative_pnl) in zip(av, pnl):
        require(isinstance(ts, int) and ts == pnl_ts and ts >= 0, "Invalid timestamps")
        require(not points or ts > points[-1][0], "Non-increasing timestamps")
        equity, cumulative_pnl = Decimal(equity), Decimal(cumulative_pnl)
        require(equity.is_finite() and cumulative_pnl.is_finite() and equity >= 0, "Invalid values")
        points.append((ts, equity, cumulative_pnl))
    return points


def analyse(case, csv_dir=None):
    evidence = json.loads((ROOT / case["evidence"]).read_text())
    expected = json.loads((ROOT / case["expected"]).read_text())
    sha = hashlib.sha256(evidence["raw"].encode()).hexdigest()
    require(sha == evidence["sha256"] == case["portfolioSha256"], "Evidence hash mismatch")
    require(evidence["address"] == expected["address"] == case["address"], "Address mismatch")
    pairs = json.loads(evidence["raw"])
    require(len({name for name, _ in pairs}) == len(pairs), "Duplicate windows")
    windows = dict(pairs)
    month, all_time = window_points(windows["month"]), window_points(windows["allTime"])
    end = month[-1][0]
    require(all_time[-1][0] == end and close(month[-1][1], all_time[-1][1]), "Endpoint mismatch")
    offset = all_time[-1][2] - month[-1][2]
    month = [(ts, av, pnl + offset) for ts, av, pnl in month]
    reference = {p[0]: p for p in all_time}
    for p in month:
        if p[0] in reference:
            q = reference[p[0]]
            require(close(p[1], q[1]) and close(p[2], q[2]), "Overlapping histories disagree")
    first_funded = next(p[0] for p in all_time if p[1] > 0)
    start = max(end - 90 * DAY, first_funded)
    # Match buildSeries(history=null): no interpolation, month takes precedence.
    points = [(*p, False) for p in all_time if start <= p[0] < month[0][0]]
    points += [(*p, True) for p in month if p[0] >= start]
    require(len(points) >= 2, "Insufficient stitched history")
    peak_equity = max(p[1] for p in points)
    nav, intervals = [ONE], []
    for a, b in zip(points, points[1:]):
        pnl = b[2] - a[2]
        flow = b[1] - a[1] - pnl
        capital = a[1] + max(flow, ZERO)
        # These published cases have no skipped/dust intervals. Refuse to
        # silently produce a candidate-like return if that assumption changes.
        require(capital > 0 and capital >= peak_equity * Decimal("0.01"), "Skipped/dust interval")
        r = pnl / capital
        require(r.is_finite() and r > -1, "Invalid or ruined return path")
        nav.append(nav[-1] * (ONE + r))
        intervals.append({"from_utc": iso(a[0]), "to_utc": iso(b[0]),
            "days": Decimal(b[0] - a[0]) / DAY, "starting_equity_usd": a[1], "ending_equity_usd": b[1],
            "pnl_change_usd": pnl, "inferred_net_flow_usd": flow, "return_denominator_usd": capital,
            "interval_return_pct": r * 100, "cumulative_return_pct": (nav[-1] - ONE) * 100,
            "both_endpoints_from_month": a[3] and b[3]})

    def period(a, b):
        peak, mdd, peak_at, dd_peak, dd_trough = nav[a], ZERO, a, None, None
        for i in range(a + 1, b + 1):
            if nav[i] > peak:
                peak, peak_at = nav[i], i
            dd = ONE - nav[i] / peak
            if dd > mdd:
                mdd, dd_peak, dd_trough = dd, iso(points[peak_at][0]), iso(points[i][0])
        return {"start": iso(points[a][0]), "end": iso(points[b][0]),
            "days": Decimal(points[b][0] - points[a][0]) / DAY,
            "return": nav[b] / nav[a] - ONE, "pnlUsd": points[b][2] - points[a][2],
            "maxDrawdown": mdd, "drawdownPeak": dd_peak, "drawdownTrough": dd_trough,
            "startEquityUsd": points[a][1], "endEquityUsd": points[b][1],
            "inferredNetFlowUsd": points[b][1] - points[a][1] - (points[b][2] - points[a][2])}

    last = len(points) - 1
    best = max(((a, b) for a in range(last) for b in range(a + 1, last + 1)
        if points[b][0] - points[a][0] >= 30 * DAY),
        key=lambda ab: (nav[ab[1]] / nav[ab[0]] - ONE, points[ab[1]][0] - points[ab[0]][0]))
    nearest_month = min(range(len(points)), key=lambda i: abs(points[i][0] - (end - 30 * DAY)))
    calculated = {"observation": period(0, last), "bestStage": period(*best), "recentMonth": period(nearest_month, last)}
    for field, actual in calculated.items():
        target = expected[field]
        for key in ["start", "end", "drawdownPeak", "drawdownTrough"]:
            require(actual[key] == target[key], f"{case['name']}: {field}.{key} differs")
        for key in ["days", "return", "pnlUsd", "maxDrawdown"]:
            require(abs(actual[key] - Decimal(str(target[key]))) < Decimal("1e-8"),
                f"{case['name']}: {field}.{key} differs")
    if csv_dir:
        csv_dir.mkdir(parents=True, exist_ok=True)
        with (csv_dir / f"{case['name']}.intervals.csv").open("w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(intervals[0]), lineterminator="\n")
            writer.writeheader()
            writer.writerows(intervals)
    return {"case": case["name"], "address": case["address"], "verified": True,
        "intervals": len(intervals), "frozenDecision": expected["decision"],
        "maxIntervalReturnPct": max(i["interval_return_pct"] for i in intervals),
        "inferredPositiveIntervalFlowsUsd": sum((max(i["inferred_net_flow_usd"], ZERO) for i in intervals), ZERO),
        "inferredNegativeIntervalFlowsUsd": sum((min(i["inferred_net_flow_usd"], ZERO) for i in intervals), ZERO),
        **calculated}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv-dir", type=Path, help="Optional directory for per-interval CSV exports")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "manifest.json").read_text())
    source = manifest["sourceSnapshot"]
    require(hashlib.sha256((ROOT / source["path"]).read_bytes()).hexdigest() == source["sha256"],
        "Reference source snapshot hash mismatch")
    results = [analyse(c, args.csv_dir) for c in manifest["cases"]]
    print(json.dumps(results, indent=2, default=lambda x: str(x) if isinstance(x, Decimal) else x))
    print("AUDIT_OK: 2 evidence hashes and all documented period calculations match")
