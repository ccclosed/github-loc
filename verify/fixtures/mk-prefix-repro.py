#!/usr/bin/env python3
"""Минимальная репродукция дефекта D1 (ustar prefix): файл с путём 154 символа.

  python3 verify/fixtures/mk-prefix-repro.py   # -> /tmp/ghloc-verify/prefix-repro.tar.gz
  node verify/engine-trace.mjs /tmp/ghloc-verify/prefix-repro.tar.gz
"""
import gzip, io, os, tarfile

long_dir, long_name = 'a' * 60, 'b' * 80
path = f'repo-main/{long_dir}/{long_name}.py'
data = b'x = 1\ny = 2\n'
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode='w', format=tarfile.USTAR_FORMAT) as t:
    ti = tarfile.TarInfo(path); ti.size = len(data); t.addfile(ti, io.BytesIO(data))
    ti2 = tarfile.TarInfo('repo-main/short.py'); ti2.size = len(data); t.addfile(ti2, io.BytesIO(data))
out = os.environ.get('OUT', '/tmp/ghloc-verify/prefix-repro.tar.gz')
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, 'wb') as f:
    f.write(gzip.compress(buf.getvalue()))
h = buf.getvalue()[0:512]
assert h[345:500].split(b'\0')[0].startswith(b'repo-main/'), 'prefix не записан — репро недействительно'
print(f'{out}: путь {len(path)} симв. записан в prefix-поле [345:500); ожидаем counted')
