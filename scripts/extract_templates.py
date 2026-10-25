#!/usr/bin/env python3
"""Extract CyberBrick firmware template configs from the app bundle into JSON files.

The app defines templates as static consts inside the renderer bundle
(JKe() maps template keys -> const objects, CN/EN variants). They are not
reachable at runtime (module-internal, no window export), so we extract the
data once and ship it as JSON — the same data the app's
createProjectFromTemplate would deep-clone into addFirmware.

Re-run after an app upgrade (bundle path + minified names change):
  python3 scripts/extract_templates.py
Update BUNDLE and the TEMPLATES map from the new JKe definition.

Output: src/core/templates/<key>.json — {en: {...}, cn: {...}}
"""
import json
import os
import re
import subprocess
import sys

BUNDLE = os.path.expanduser(
    '~/codespace/rea/targets/cyberbrick-asar/.vite/renderer/main_window/assets/index-C-WvfsRp.js'
)
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'src', 'core', 'templates')

# template key -> [EN const, CN const]   (from JKe in the bundle)
TEMPLATES = {
    'forklift': ('Tqe', 'cKe'),
    'truck': ('UKe', 'QKe'),
    'forklift_and_truck': ('$qe', 'Xqe'),
    'ball_car': ('aqe', 'xqe'),
    'official_remote': ('yKe', 'DKe'),
    'none': (None, None),
    'custom': ('h1', 'h1'),
}

s = open(BUNDLE, encoding='utf8').read()


def find_def(name):
    """Return raw source of `NAME=<value>`; value must be an object/array
    literal, ()=>(...), ()=>literal, or a string literal. Anything else
    (function bodies, class exprs, member assignments) → None."""
    m = re.search(r'(?<![\w$.])' + re.escape(name) + r'\s*=\s*', s)
    if not m:
        return None
    i = m.end()
    # object/array literal — brace match
    if s[i] in '{[':
        open_ch, close_ch = s[i], '}' if s[i] == '{' else ']'
        depth = 0
        in_str = None
        esc = False
        for j in range(i, len(s)):
            c = s[j]
            if in_str:
                if esc:
                    esc = False
                elif c == '\\':
                    esc = True
                elif c == in_str:
                    in_str = None
                continue
            if c in '"\'`':
                in_str = c
            elif c == open_ch:
                depth += 1
            elif c == close_ch:
                depth -= 1
                if depth == 0:
                    return s[i:j + 1]
        return None
    # arrow function ()=>( expr ) or ()=>literal
    m2 = re.match(r'\(\s*\)\s*=>\s*', s[i:])
    if m2:
        k = i + m2.end()
        if s[k] == '(':
            depth = 0
            in_str = None
            esc = False
            for j in range(k, len(s)):
                c = s[j]
                if in_str:
                    if esc:
                        esc = False
                    elif c == '\\':
                        esc = True
                    elif c == in_str:
                        in_str = None
                    continue
                if c in '"\'`':
                    in_str = c
                elif c == '(':
                    depth += 1
                elif c == ')':
                    depth -= 1
                    if depth == 0:
                        return s[i:j + 1]
            return None
        m3 = re.match(r'(\{[^{}]*\}|"(?:[^"\\]|\\.)*"|[\w.]+)', s[k:])
        if m3:
            return s[i:k + m3.end()]
        return None
    # string literal
    if s[i] == '"':
        j = s.find('"', i + 1)
        return s[i:j + 1] if j != -1 else None
    return None


def collect(entry, out, seen, depth=0):
    if entry in seen or depth > 12:
        return
    raw = find_def(entry)
    if raw is None:
        return
    # skip garbage defs (code fragments matched inside larger expressions)
    if not (raw[0] in '{[' or raw.startswith('()') or raw[0] == '"'):
        return
    seen.add(entry)
    out[entry] = raw
    refs = set(re.findall(r'(?<![\w$.])([A-Za-z_$][\w$]{1,5})(?=\s*[:,)\]}])', raw))
    for ref in sorted(refs):
        if ref in ('true', 'false', 'null'):
            continue
        collect(ref, out, seen, depth + 1)


def topo_sort(defs):
    """Order const defs so deps come before dependents (avoids TDZ at eval)."""
    order, emitted, pending = [], set(), dict(defs)

    def deps_of(raw):
        return {
            r for r in re.findall(r'(?<![\w$.])([A-Za-z_$][\w$]{1,5})(?=\s*[:,)\]}])', raw)
            if r in pending and r not in emitted
        }

    while pending:
        progressed = False
        for name in sorted(pending):
            if not (deps_of(pending[name]) - set()):
                continue
        # simple iterative pass: emit any def whose deps are all emitted
        for name in sorted(pending):
            raw = pending[name]
            if all(d in emitted for d in deps_of(raw)):
                order.append((name, raw))
                emitted.add(name)
                del pending[name]
                progressed = True
                break
        if not progressed:
            # circular refs among literals — emit remaining anyway
            for name, raw in pending.items():
                order.append((name, raw))
            break
    return order


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    ok = True
    for key, (en, cn) in TEMPLATES.items():
        dest = os.path.join(OUT_DIR, f'{key}.json')
        if en is None:
            json.dump({'en': {}, 'cn': {}}, open(dest, 'w'), indent=2)
            print(f'{key}: empty template')
            continue
        out, seen = {}, set()
        collect(en, out, seen)
        collect(cn, out, seen)
        defs = '\n'.join(f'const {n} = {v};' for n, v in topo_sort(out))
        if en == 'h1':
            # h1 references the bp enum member (bp.Custom = "custom") — provide it
            defs += '\nconst bp = { Custom: "custom" };'
            body = '\nreturn { en: h1(), cn: h1() };'
        else:
            body = f'\nreturn {{ en: JSON.parse(JSON.stringify({en})), cn: JSON.parse(JSON.stringify({cn})) }};'
        node = (
            "const fs=require('fs');"
            f"const fn=new Function({(defs + body)!r});"
            "fs.writeFileSync(process.argv[1], JSON.stringify(fn(), null, 2));"
        )
        r = subprocess.run(['node', '-e', node, dest], capture_output=True, text=True)
        if r.returncode != 0:
            print(f'{key}: FAILED: {r.stderr.splitlines()[-1][:200] if r.stderr else "unknown"}')
            ok = False
            continue
        data = json.load(open(dest))
        print(f"{key}: en={sorted(k for k in data['en'] if k != 'sender')} "
              f"sender_channels={len(data['en'].get('sender', {}).get('channels', []))} "
              f"bytes={os.path.getsize(dest)}")
    print('done →', OUT_DIR)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
