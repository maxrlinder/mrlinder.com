#!/usr/bin/env python3
"""Publish a training Hjärter run's latest checkpoint to the site every few hours while it trains.

Usage (detached, beside the gym's tools/train_cuda.sh):
    setsid nohup python3 scripts/hjarter-autopublish.py >> tmp/hjarter-autopublish.log 2>&1 &
    python3 scripts/hjarter-autopublish.py --once --dry-run   # one cycle, no commit or push

Each cycle:
 1. reads the run's checkpoints/latest.json and checks the checkpoint against its hash;
 2. if it is newer than the model on origin/main, exports it in a detached worktree
    (tmp/autopublish, so the main checkout is never touched) with
    scripts/export-hjarter-model.py, removes the previous ONNX file and runs
    scripts/check.mjs;
 3. commits the model directory and pushes main. When main's tip is this script's
    own previous update, the new commit replaces it (same parent, pushed with
    --force-with-lease), so history keeps one auto-published model instead of one
    per update (README.md, "Large files"). Anything else at the tip gets a normal
    commit on top.

Stops after the cycle that finds the run's training supervisor gone.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'site/RL-environment/hjarter/model'
TRAILER = 'Auto-published-by: scripts/hjarter-autopublish.py'


def log(message):
    print(f'[{datetime.now(timezone.utc):%Y-%m-%dT%H:%M:%SZ}] {message}', flush=True)


def run(*command, cwd=ROOT, env=None, timeout=1800):
    result = subprocess.run(command, cwd=cwd, env=env, timeout=timeout, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'{" ".join(map(str, command))} failed ({result.returncode}):\n'
                           f'{result.stdout[-2000:]}{result.stderr[-2000:]}')
    return result.stdout.strip()


def training_alive(run_name):
    """Whether the run's training supervisor (tools/train_cuda.sh or train_supervised.sh) is running."""
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            args = (proc / 'cmdline').read_bytes().split(b'\0')
        except OSError:
            continue
        names = [Path(arg.decode(errors='replace')).name for arg in args]
        if any(name in ('train_cuda.sh', 'train_supervised.sh') for name in names) \
                and 'hjarter' in names and run_name in names:
            return True
    return False


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 22), b''):
            digest.update(block)
    return digest.hexdigest()


def own_update(commit):
    """Whether ``commit`` is a previous update of this script: its trailer, one parent, model files only."""
    message = run('git', 'log', '-1', '--format=%B', commit)
    parents = run('git', 'log', '-1', '--format=%P', commit).split()
    files = run('git', 'diff-tree', '--no-commit-id', '--name-only', '-r', commit).splitlines()
    return TRAILER in message and len(parents) == 1 and all(f.startswith(MODEL + '/') for f in files)


def publish(args):
    pointer_file = args.gym / 'runs/hjarter' / args.run / 'checkpoints/latest.json'
    pointer = json.loads(pointer_file.read_text())
    checkpoint = pointer_file.parent / pointer['path']
    iteration = int(pointer['iteration'])
    run('git', 'fetch', '--quiet', 'origin', 'main')
    tip = run('git', 'rev-parse', 'origin/main')
    live = json.loads(run('git', 'show', f'origin/main:{MODEL}/manifest.json'))
    if live.get('run') == args.run and int(live['iteration']) >= iteration:
        log(f'up to date: {args.run} {iteration} is live')
        return
    if sha256(checkpoint) != pointer['sha256']:
        log(f'{checkpoint.name} does not match latest.json; next cycle')
        return
    replace = own_update(tip)
    base = run('git', 'rev-parse', f'{tip}^') if replace else tip

    worktree = ROOT / 'tmp/autopublish'
    if not (worktree / '.git').exists():
        run('git', 'worktree', 'prune')
        run('git', 'worktree', 'add', '--detach', str(worktree), base)
    run('git', 'checkout', '--quiet', '--detach', '--force', base, cwd=worktree)
    run('git', 'reset', '--quiet', '--hard', base, cwd=worktree)
    run('git', 'clean', '-fdq', '--', MODEL, cwd=worktree)
    previous = json.loads((worktree / MODEL / 'manifest.json').read_text())

    env = dict(os.environ, PYTHONPATH=str(args.deps))
    started = time.monotonic()
    run('nice', '-n', '10', str(args.python), 'scripts/export-hjarter-model.py',
        '--source', str(args.gym), '--checkpoint', str(checkpoint), cwd=worktree, env=env)
    manifest = json.loads((worktree / MODEL / 'manifest.json').read_text())
    if manifest['file'] != previous['file']:
        (worktree / MODEL / previous['file']).unlink(missing_ok=True)
    run(args.node, 'scripts/check.mjs', cwd=worktree)
    log(f'exported and checked {args.run} {manifest["iteration"]} in {time.monotonic() - started:.0f}s '
        f'({manifest["bytes"] / 1e6:.1f} MB)')
    if args.dry_run:
        log(f'dry run: would {"replace" if replace else "add"} on {tip[:7]}; nothing committed')
        return

    run('git', 'add', '-A', '--', MODEL, cwd=worktree)
    message = (f'Hjärter: checkpoint {manifest["iteration"]:,} of {args.run} is live\n\n'
               f'Replaces checkpoint {previous["iteration"]:,}. {TRAILER}')
    run('git', 'commit', '--quiet', '-m', message, cwd=worktree)
    commit = run('git', 'rev-parse', 'HEAD', cwd=worktree)
    # The lease: push only if main is still the tip this update was built on.
    run('git', 'push', '--quiet', f'--force-with-lease=refs/heads/main:{tip}', args.push_url,
        f'{commit}:refs/heads/main', cwd=worktree, timeout=1800)
    run('git', 'fetch', '--quiet', 'origin', 'main')
    log(f'pushed {commit[:7]}: {args.run} {manifest["iteration"]} live, '
        f'{"replacing" if replace else "on top of"} {tip[:7]}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--gym', type=Path, default=ROOT.parent / 'card_playing_gym')
    parser.add_argument('--run', default='h1')
    parser.add_argument('--every', type=float, default=2.0, help='hours between cycles')
    parser.add_argument('--python', type=Path, help="the gym's interpreter (default: its .venv)")
    parser.add_argument('--deps', type=Path, default=ROOT / 'tmp/export-deps', help='onnx and onnxruntime')
    parser.add_argument('--node', default=shutil.which('node') or 'node')
    parser.add_argument('--once', action='store_true', help='one cycle, then exit')
    parser.add_argument('--dry-run', action='store_true', help='export and check, no commit or push')
    parser.add_argument('--push-url', help="where to push (default: origin's GitHub repository over SSH)")
    args = parser.parse_args()
    if args.push_url is None:
        # origin is HTTPS, which a detached process has no credentials for; SSH uses the machine's key.
        origin = run('git', 'remote', 'get-url', 'origin')
        prefix = 'https://github.com/'
        args.push_url = f'git@github.com:{origin.removeprefix(prefix).removesuffix(".git")}.git' \
            if origin.startswith(prefix) else origin
    args.gym = args.gym.resolve()
    args.python = args.python or args.gym / '.venv/bin/python'
    log(f'publishing {args.run} every {args.every:g} h (pid {os.getpid()})')
    while True:
        alive = training_alive(args.run)
        try:
            publish(args)
        except Exception as error:  # noqa: BLE001 - a failed cycle retries on the next one
            log(f'cycle failed: {error}')
        if args.once:
            return 0
        if not alive:
            log(f'{args.run} is not training; stopping')
            return 0
        time.sleep(args.every * 3600)


if __name__ == '__main__':
    sys.exit(main())
