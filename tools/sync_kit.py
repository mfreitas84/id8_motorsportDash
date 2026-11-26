#!/usr/bin/env python3
"""Copy the MGU App Kit (cauliflowermossgrape/idrive7-apps, MIT) into ./kit at one pinned commit.

    python tools/sync_kit.py <path-to-idrive7-apps-clone>             # kit only (what git tracks)
    python tools/sync_kit.py <path-to-idrive7-apps-clone> --with-emu  # also the live emulator (local only)

Why vendored, not a submodule: an MGU Store "repo tree" source is built on the head unit from this
repository's files (mgu-repo.json), and the kit's build.py expects kit/ next to apps/.

What is left out, and why:
  kit/renderd/                     the GPU renderer's source (GPL-3.0). The car already runs it
                                   (installed by MGU Store); apps only talk to it over a socket.
  kit/emu/                         the emulator's draw engine is that renderer compiled to WebAssembly
                                   (GPL-3.0). --with-emu copies it for local use; .gitignore keeps it out.
  kit/icons/                       the upstream apps' tile icons.
  kit/tools/test_*, fixtures/      tests for the upstream apps (they need apps/ we don't have).
  kit/localization/diagnostic-full.{ru,zh-CN}.json   26 MB of fault-text translations, used only by
                                   --language ru / zh-CN builds of the Fault Scanner.

Everything copied keeps its MIT licence: kit/LICENSE is upstream's, kit/UPSTREAM.md records the commit.
"""
import os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
DEST = os.path.join(ROOT, 'kit')

SKIP_DIRS = {'renderd', 'emu', 'icons', 'fixtures', '__pycache__', '.font-cache'}
SKIP_FILES = {'diagnostic-full.ru.json', 'diagnostic-full.zh-CN.json'}


def skip(rel):
    parts = rel.replace('\\', '/').split('/')
    name = parts[-1]
    if any(p in SKIP_DIRS for p in parts[:-1]) or name in SKIP_DIRS:
        return True
    if name in SKIP_FILES or name.endswith('.pyc'):
        return True
    if len(parts) >= 2 and parts[0] == 'tools' and name.startswith('test_'):
        return True
    return False


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    src_repo = os.path.abspath(sys.argv[1])
    with_emu = '--with-emu' in sys.argv[2:]
    src = os.path.join(src_repo, 'kit')
    if not os.path.isfile(os.path.join(src, 'runtime', 'mgu.js')):
        raise SystemExit('not an idrive7-apps clone: ' + src_repo)
    commit = subprocess.check_output(['git', '-C', src_repo, 'rev-parse', 'HEAD'], text=True).strip()
    date = subprocess.check_output(['git', '-C', src_repo, 'log', '-1', '--format=%cs'], text=True).strip()
    dirty = subprocess.check_output(['git', '-C', src_repo, 'status', '--porcelain', 'kit'], text=True).strip()
    if dirty:
        raise SystemExit('the clone has local changes under kit/; sync from a clean checkout')

    keep = {'UPSTREAM.md', 'LICENSE'}
    if os.path.isdir(DEST):
        for name in os.listdir(DEST):
            if name in keep or (name == 'emu' and not with_emu):
                continue
            p = os.path.join(DEST, name)
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    os.makedirs(DEST, exist_ok=True)

    count = 0
    for d, dirs, files in os.walk(src):
        rel_dir = os.path.relpath(d, src)
        dirs[:] = [x for x in dirs if not skip(os.path.join(rel_dir, x))]
        for f in files:
            rel = os.path.normpath(os.path.join(rel_dir, f))
            if skip(rel):
                continue
            out = os.path.join(DEST, rel)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            shutil.copy2(os.path.join(d, f), out)
            count += 1

    if with_emu:
        shutil.rmtree(os.path.join(DEST, 'emu'), ignore_errors=True)
        shutil.copytree(os.path.join(src, 'emu'), os.path.join(DEST, 'emu'))
        print('emulator copied to kit/emu (git-ignored: GPL-3.0, local use only)')

    shutil.copy2(os.path.join(src_repo, 'LICENSE'), os.path.join(DEST, 'LICENSE'))
    with open(os.path.join(DEST, 'UPSTREAM.md'), 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(
            '# Vendored MGU App Kit\n\n'
            'This folder is a copy of `kit/` from '
            '[cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps), '
            'MIT License (see `LICENSE` here), Copyright (c) 2026 cauliflowermossgrape.\n\n'
            '| | |\n|---|---|\n'
            '| Commit | [`%s`](https://github.com/cauliflowermossgrape/idrive7-apps/tree/%s/kit) |\n'
            '| Date | %s |\n'
            '| Files | %d |\n\n'
            "Don't edit files here: change them upstream or in `apps/`, then re-run\n"
            '`python tools/sync_kit.py <idrive7-apps clone>`. What is left out and why is at the top of\n'
            '`tools/sync_kit.py` (the GPL-3.0 renderer and emulator, upstream icons and tests, and the\n'
            'ru / zh-CN fault-text databases).\n' % (commit, commit, date, count))
    print('kit/ synced from %s (%s): %d files' % (commit[:10], date, count))


if __name__ == '__main__':
    main()
