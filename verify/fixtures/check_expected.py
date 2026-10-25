#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Самопроверка оракула на мини-фикстуре: прогон нескольких наборов опций и
сравнение с ЛИТЕРАЛЬНЫМИ ожиданиями из fixtures/expected.json.

Никакой код движка не используется. Печатает таблицу и возвращает 1 при расхождении.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VERIFY = os.path.dirname(HERE)
ORACLE = os.path.join(VERIFY, "oracle.py")
MINI = os.path.join(HERE, "mini.tar.gz")
EXPECTED = os.path.join(HERE, "expected.json")
RAW = os.path.join(VERIFY, "raw")


def get_path(doc: dict, dotted: str):
    cur = doc
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return ("<отсутствует>",)
        cur = cur[part]
    return cur


def make_extra_inputs() -> None:
    """mini.truncated.tar.gz (обрыв посреди записи) и mini.corrupt.tar.gz (не gzip)."""
    with open(MINI, "rb") as f:
        data = f.read()
    with open(os.path.join(HERE, "mini.truncated.tar.gz"), "wb") as f:
        f.write(data[: len(data) * 3 // 4])
    with open(os.path.join(HERE, "mini.corrupt.tar.gz"), "wb") as f:
        f.write(b"this is definitely not a gzip stream\n" * 64)


def run_oracle(args: list[str]) -> tuple[int, dict, str]:
    proc = subprocess.run([sys.executable, ORACLE] + args, capture_output=True, text=True)
    out = proc.stdout.strip()
    try:
        doc = json.loads(out) if out.startswith("{") else {}
    except json.JSONDecodeError:
        doc = {}
    return proc.returncode, doc, proc.stderr.strip()


def compare(name: str, doc: dict, expect: dict, log: list[str]) -> tuple[int, int]:
    ok = bad = 0
    for key, want in expect.items():
        got = get_path(doc, key)
        good = got == want
        ok, bad = (ok + 1, bad) if good else (ok, bad + 1)
        log.append("  %-4s %-34s ожидалось %-28s получено %s"
                   % ("OK" if good else "FAIL", key, json.dumps(want, ensure_ascii=False),
                      json.dumps(got, ensure_ascii=False)))
    return ok, bad


def main() -> int:
    os.makedirs(RAW, exist_ok=True)
    make_extra_inputs()
    exp = json.load(open(EXPECTED, encoding="utf-8"))
    runs = exp["runs"]
    total_ok = total_bad = 0
    log: list[str] = []
    raw_dump: list[str] = []

    cases = [
        ("A_default_small_limit", MINI, "mini"),
        ("B_default_5mib_limit", MINI, "mini"),
        ("C_no_blank_no_comment", MINI, "mini"),
        ("D_chunk_size_1", MINI, "mini"),
    ]
    for name, path, _ in cases:
        spec = runs[name]
        args = ["--file", path] + spec["args"] + ["--no-meta"]
        rc, doc, err = run_oracle(args)
        log.append("\n[%s] %s\n  команда: oracle.py %s (rc=%d)" % (name, spec["why"],
                                                                  " ".join(args), rc))
        if err:
            log.append("  stderr: " + err.replace("\n", " | "))
        raw_dump.append("### %s\n$ python3 verify/oracle.py %s\nrc=%d\n%s\n"
                        % (name, " ".join(args), rc, json.dumps(doc, ensure_ascii=False,
                                                                indent=2)))
        if rc != 0 or not doc:
            log.append("  FAIL: оракул не вернул JSON (rc=%d)" % rc)
            total_bad += 1
            continue
        ok, bad = compare(name, doc, spec["expect"], log)
        total_ok += ok
        total_bad += bad

    # E: обрыв архива
    spec = runs["E_truncated_archive"]
    args = ["--file", os.path.join(HERE, "mini.truncated.tar.gz")] + spec["args"] + ["--no-meta"]
    rc, doc, err = run_oracle(args)
    log.append("\n[E_truncated_archive] %s\n  команда: oracle.py %s (rc=%d)"
               % (spec["why"], " ".join(args), rc))
    raw_dump.append("### E_truncated_archive\n$ python3 verify/oracle.py %s\nrc=%d\n%s\n"
                    % (" ".join(args), rc, json.dumps(doc, ensure_ascii=False, indent=2)))
    ok, bad = compare("E", doc, spec["expect"], log)
    total_ok += ok
    total_bad += bad

    # F: битый gzip
    spec = runs["F_bad_gzip"]
    args = ["--file", os.path.join(HERE, "mini.corrupt.tar.gz")] + spec["args"] + ["--no-meta"]
    rc, doc, err = run_oracle(args)
    log.append("\n[F_bad_gzip] %s\n  команда: oracle.py %s (rc=%d)"
               % (spec["why"], " ".join(args), rc))
    raw_dump.append("### F_bad_gzip\n$ python3 verify/oracle.py %s\nrc=%d\n%s\n"
                    % (" ".join(args), rc, json.dumps(doc, ensure_ascii=False, indent=2)))
    ok, bad = compare("F", doc, spec["expect"], log)
    total_ok += ok
    total_bad += bad

    # G: лимит сжатого архива
    spec = runs["G_archive_limit"]
    args = ["--file", MINI] + spec["args"] + ["--no-meta"]
    rc, doc, err = run_oracle(args)
    log.append("\n[G_archive_limit] %s\n  команда: oracle.py %s (rc=%d)"
               % (spec["why"], " ".join(args), rc))
    raw_dump.append("### G_archive_limit\n$ python3 verify/oracle.py %s\nrc=%d\n%s\n"
                    % (" ".join(args), rc, json.dumps(doc, ensure_ascii=False, indent=2)))
    ok, bad = compare("G", doc, spec["expect"], log)
    total_ok += ok
    total_bad += bad
    if rc != 3:
        log.append("  FAIL: ожидался код возврата 3 (too_large), получен %d" % rc)
        total_bad += 1
    else:
        total_ok += 1

    # H: встроенная самопроверка счётчика (граничные случаи SPEC 2.4)
    proc = subprocess.run([sys.executable, ORACLE, "--self-test"], capture_output=True,
                          text=True)
    log.append("\n[H_builtin_self_test] граничные случаи счётчика (в т.ч. чтение по 1 байту)"
               "\n  rc=%d\n%s" % (proc.returncode, proc.stdout.strip()))
    raw_dump.append("### H_builtin_self_test\n$ python3 verify/oracle.py --self-test\nrc=%d\n%s\n"
                    % (proc.returncode, proc.stdout))
    if proc.returncode == 0:
        total_ok += 1
    else:
        total_bad += 1

    log.append("\nИТОГО: проверок %d, расхождений %d" % (total_ok + total_bad, total_bad))
    text = "\n".join(log)
    print(text)
    with open(os.path.join(RAW, "selfcheck-fixture.txt"), "w", encoding="utf-8") as f:
        f.write(text + "\n")
    with open(os.path.join(RAW, "selfcheck-fixture-raw.json.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(raw_dump))
    return 1 if total_bad else 0


if __name__ == "__main__":
    sys.exit(main())