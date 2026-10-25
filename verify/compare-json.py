#!/usr/bin/env python3
"""Сверка JSON оракула и движка: total/files/bytes/perLanguage/skipped/entries.

  python3 verify/compare-json.py oracle.json engine.json [--label имя]

Печатает человекочитаемый отчёт и exit code 1, если расхождения НЕ объяснены
разрешённым списком (perLanguage-имена, skippedReasons-порядок, entries, ms).
"""
from __future__ import annotations

import argparse
import json
import sys


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("oracle")
    ap.add_argument("engine")
    ap.add_argument("--label", default="")
    a = ap.parse_args()

    o, e = load(a.oracle), load(a.engine)
    label = a.label or a.oracle
    print(f"# {label}")

    def row(name, ov, ev, hard=True):
        mark = "OK " if ov == ev else ("РАЗН" if hard else "инфо")
        print(f"  {mark} {name:<16} оракул={ov!r:<28} движок={ev!r}")
        return ov == ev

    hard_ok = True
    hard_ok &= row("total", o.get("total"), e.get("total"))
    hard_ok &= row("files", o.get("files"), e.get("files"))
    hard_ok &= row("bytes", o.get("bytes"), e.get("bytes"))
    hard_ok &= row("truncated", o.get("truncated"), e.get("truncated"))
    # skipped/entries/skippedReasons — диагностические (порядок причин в SPEC не зафиксирован)
    row("skipped", o.get("skipped"), e.get("skipped"), hard=False)
    row("entries", o.get("entries"), e.get("entries"), hard=False)
    if o.get("skippedReasons") != e.get("skippedReasons"):
        print(f"  инфо skippedReasons  оракул={o.get('skippedReasons')}")
        print(f"                        движок={e.get('skippedReasons')}")

    op, ep = o.get("perLanguage", {}), e.get("perLanguage", {})
    # total по языкам
    langs = sorted(set(op) | set(ep))
    print("  perLanguage (lines / files):")
    for lang in sorted(langs, key=lambda n: -(op.get(n, {}).get("lines", 0))):
        ol = op.get(lang, {}).get("lines")
        el = ep.get(lang, {}).get("lines")
        of = op.get(lang, {}).get("files")
        ef = ep.get(lang, {}).get("files")
        mark = "OK " if (ol == el and of == ef) else "РАЗН"
        print(f"    {mark} {lang:<18} оракул={ol}/{of}  движок={el}/{ef}")

    only_o = sorted(set(op) - set(ep))
    only_e = sorted(set(ep) - set(op))
    if only_o:
        print(f"  инфо только у оракула: {only_o}")
    if only_e:
        print(f"  инфо только у движка:  {only_e}")

    diff_langs = [l for l in langs if op.get(l, {}).get("lines") != ep.get(l, {}).get("lines")]
    if diff_langs:
        print(f"  РАСХОЖДЕНИЯ по языкам: {diff_langs}")
    print()
    return 0 if hard_ok else 1


if __name__ == "__main__":
    sys.exit(main())