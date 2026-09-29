#!/usr/bin/env python3
"""RESERVED-KEY scan for scripts/check-logging.sh.

Every logger stamps the machine identity (host, machine_id, mdm_device_id,
mdm_serial) on each line, and log pipelines label lines with the device by
those keys. A call site that logs a URL's or a git remote's host under
`host` would relabel its line with a fake device, so the loggers let the
identity win and this scan keeps call sites off the keys: name the value for
what it is (url_host, git_host, bind_host).

`user` is reserved the same way: it is the line's signed-in user, which the
exporters stamp as the `user` attribute. A call site logging an OS account or
a sign-in result names it os_user, signed_in_user, remote_user.

Reads file paths on stdin, prints `file:line:source` for each violation.
Scans the whole argument list of a logger call, so a field object spread
over several lines is covered. Opt out with a trailing `// log-key-ok: <reason>`.
"""
import re
import sys

RESERVED = r'(host|machine_id|mdm_device_id|mdm_serial|user)'
GO_CALL = re.compile(r'\butils\.(LogWithFields|TraceWithFields)\(')
GO_KEY = re.compile(r'"' + RESERVED + r'"\s*:')
TS_CALL = re.compile(r'(?<![\w.])(log|debug|warn|error|info|trace|rInfo|rDebug|rWarn|rError|rTrace|_log|_warn|_error|_debug|_info)\(')
# A key sits right after `{` or `,`: `{ host }`, `{ a, host: x }`. A value
# (`url_host: host`) sits after `:` and is not matched.
TS_KEY = re.compile(r'[{,]\s*' + RESERVED + r'\s*(:|,|\})')


def call_args(src, start):
    """The text of a call's argument list, from just after its `(`."""
    depth, i = 1, start
    while i < len(src) and depth:
        c = src[i]
        if c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        i += 1
    return src[start:i - 1]


def scan(path):
    src = open(path, encoding='utf-8', errors='replace').read()
    lines = src.splitlines()
    go = path.endswith('.go')
    call, key = (GO_CALL, GO_KEY) if go else (TS_CALL, TS_KEY)
    for m in call.finditer(src):
        args = call_args(src, m.end())
        if not go and '{' not in args:
            continue
        for k in key.finditer(args):
            lineno = src.count('\n', 0, m.end() + k.start(1)) + 1
            text = lines[lineno - 1].strip()
            if 'log-key-ok:' in text:
                continue
            print(f'{path}:{lineno}:{text}')


for p in sys.stdin.read().split():
    scan(p)
