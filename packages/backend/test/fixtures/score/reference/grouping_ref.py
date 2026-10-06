#!/usr/bin/env python3
"""Independent reference for SPEC "Clone grouping": link groups, units, comparison against earlier
representatives' link units, and the finalist cut. Written from the SPEC text, not from score.ts.

Reads grouping-inputs.json (ranked cross-pool order and daily returns, from dump-grouping-inputs.ts)
and rewrites the grouping fields of ../links.json for every case: each ranked candidate's `cloneOf`,
`clones` and `finalist`, `finalists`, and the `distinct` and `finalists` funnel counts. Ranks, scores
and the other funnel stages do not depend on links and are left as the original reference wrote them.

    cd packages/backend && python3 -I test/fixtures/score/reference/grouping_ref.py
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
INPUTS = os.path.join(HERE, "grouping-inputs.json")
FIXTURE = os.path.join(HERE, "..", "links.json")


def pearson(a, b, min_overlap):
    """rho over the days both have; None below the overlap minimum or with zero variance."""
    days = sorted(set(a) & set(b))
    if len(days) < min_overlap:
        return None
    xs = [a[d] for d in days]
    ys = [b[d] for d in days]
    mean_x = sum(xs) / len(xs)
    mean_y = sum(ys) / len(ys)
    sxx = sum((x - mean_x) ** 2 for x in xs)
    syy = sum((y - mean_y) ** 2 for y in ys)
    sxy = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    if sxx == 0 or syy == 0:
        return None
    rho = sxy / math.sqrt(sxx * syy)
    return rho if math.isfinite(rho) else None


def link_components(addresses, links):
    """Connected components of the link graph over all inputs, ranked or not (lower-case compared)."""
    parent = {a.lower(): a.lower() for a in addresses}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for source, targets in links.items():
        for target in targets:
            s, t = source.lower(), target.lower()
            if s in parent and t in parent:  # a link to an address outside the inputs is ignored
                parent[find(s)] = find(t)
    return {a.lower(): find(a.lower()) for a in addresses}


def group(data, links):
    cfg = data["config"]
    order = [r["address"] for r in data["ranked"]]
    pools = {r["pool"] for r in data["ranked"]}
    assert len(pools) == 1, "this reference only implements the single-pool finalist cut"
    returns = {a: {day: r for day, r in series} for a, series in data["dailyReturns"].items()}
    component = link_components(data["addresses"], links)

    # Units: the ranked members of each link group, in cross-pool order; the head is the first.
    units = {}
    for address in order:
        units.setdefault(component[address.lower()], []).append(address)

    clone_of = {a: None for a in order}
    representative_units = []  # (representative, its unit), in the order representatives appear
    for unit in units.values():  # dicts keep insertion order, i.e. heads in cross-pool order
        head, members = unit[0], unit[1:]
        match = None
        for representative, footprint in representative_units:
            for account in footprint:
                rho = pearson(returns[head], returns[account], cfg["minOverlapDays"])
                if rho is not None and rho >= cfg["cloneCorrelation"]:
                    match = (representative, account, rho)
                    break
            if match:
                break
        if match:
            representative, account, rho = match
            clone_of[head] = {"address": representative, "correlation": rho}
            if account != representative:
                clone_of[head]["via"] = account
        else:
            representative_units.append((head, unit))
        target = match[0] if match else head
        for member in members:
            clone_of[member] = {"address": target, "correlation": None}

    representatives = [r for r, _ in representative_units]
    finalists = representatives[: min(cfg["finalists"], len(representatives))]
    clones = {r: [a for a in order if clone_of[a] and clone_of[a]["address"] == r] for r in representatives}
    return clone_of, clones, representatives, finalists


def main():
    data = json.load(open(INPUTS))
    fixture = json.load(open(FIXTURE))
    for case in fixture["cases"]:
        clone_of, clones, representatives, finalists = group(data, case["links"])
        expected = case["expected"]
        assert [c["address"] for c in expected["candidates"]] == [r["address"] for r in data["ranked"]]
        for candidate in expected["candidates"]:
            address = candidate["address"]
            candidate["cloneOf"] = clone_of[address]
            candidate["clones"] = clones.get(address, [])
            candidate["finalist"] = address in finalists
        expected["finalists"] = finalists
        for step in expected["funnel"]:
            if step["stage"] == "distinct":
                step["count"] = len(representatives)
            if step["stage"] == "finalists":
                step["count"] = len(finalists)
    with open(FIXTURE, "w") as out:
        out.write(json.dumps(fixture, indent=1, separators=(",", ": "), ensure_ascii=False))


if __name__ == "__main__":
    main()
