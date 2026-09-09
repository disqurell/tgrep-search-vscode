#!/usr/bin/env python3
"""POSIX advisory locks, index validation and child lifetime. No shell involved."""
import contextlib
import datetime
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading

# The helper uses the same catalog as the extension and webview.
_TRANSLATIONS = json.loads((Path(__file__).resolve().parent.parent / 'media' / 'l10n.ru.json').read_text(encoding='utf-8'))
_LANGUAGE = 'en'


def tr(message):
    return _TRANSLATIONS.get(message, message) if _LANGUAGE == 'ru' else message


FILES = ('meta.json', 'index.bin', 'lookup.bin', 'files.bin', 'files-extra.bin', 'filestamps.json')
DIRTY = '.tgrep-search-building.json'
RECEIPT = '.tgrep-search-completed.json'


def fingerprint(index):
    result = {}
    for name in FILES:
        try:
            s = (index / name).stat()
            result[name] = [s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns]
        except FileNotFoundError:
            result[name] = None
    return result


def inspect(root, index, allow_dirty=False):
    base = {'root': str(root), 'index': str(index), 'time': None, 'timeKind': 'unknown'}
    if not (index / 'meta.json').exists() and (index / DIRTY).exists():
        return dict(base, state='error', detail=tr("The previous build did not finish. Rebuild the index."))
    if not (index / 'meta.json').exists():
        return dict(base, state='missing', detail=tr("Index not found"))
    try:
        meta = json.loads((index / 'meta.json').read_text())
        if not isinstance(meta.get('root_path'), str) or not Path(meta['root_path']).is_absolute():
            raise ValueError(tr("Invalid root_path in meta.json"))
        if Path(meta['root_path']).resolve() != root:
            return dict(base, state='mismatch', detail=tr("The index belongs to another folder: ") + meta['root_path'])
        try:
            previous = json.loads((index / RECEIPT).read_text())
            if previous['root'] == str(root):
                datetime.datetime.fromisoformat(previous['completedAt'])
                base.update(time=previous['completedAt'], timeKind='completed', timeLastKnown=True)
        except (OSError, ValueError, KeyError, TypeError):
            pass
        if meta.get('version') != 2:
            raise ValueError(tr("Only index format version=2 is supported (tgrep 1.0.5)"))
        if meta.get('complete', True) is not True:
            raise ValueError(tr("The index is incomplete: complete=false"))
        if (index / DIRTY).exists() and not allow_dirty:
            raise ValueError(tr("The previous build did not finish. Rebuild the index."))
        # tgrep auto-connects through this file; do not silently use a server.
        if (index / 'serve.json').exists():
            raise ValueError(tr("Found serve.json. Stop tgrep serve and remove its metadata before using the disk index."))
        fp = fingerprint(index)
        for name in ('index.bin', 'lookup.bin', 'files.bin'):
            if fp[name] is None:
                raise ValueError(tr("Missing index file: ") + name)
        if fp['lookup.bin'][1] % 16 or fp['index.bin'][1] % 6:
            raise ValueError(tr("Invalid binary index file size"))
        if isinstance(meta.get('num_trigrams'), int) and fp['lookup.bin'][1] != meta['num_trigrams'] * 16:
            raise ValueError(tr("lookup.bin does not match meta.json; an external write may be in progress"))
        if meta.get('num_files', 0) > 0 and fp['files.bin'][1] == 0:
            raise ValueError(tr("files.bin is empty but the index is not"))
        if any(value and value[2] > fp['meta.json'][2] for name, value in fp.items() if name != 'meta.json'):
            raise ValueError(tr("Index files are newer than the final meta.json write: incomplete external update"))
        base.update(time=None, timeKind='unknown', timeLastKnown=False)
        # A receipt is exact ONLY for the very same on-disk generation.
        try:
            receipt = json.loads((index / RECEIPT).read_text())
            if receipt['fingerprint'] == fp and receipt['root'] == str(root):
                datetime.datetime.fromisoformat(receipt['completedAt'])
                base.update(time=receipt['completedAt'], timeKind='completed')
        except (OSError, ValueError, KeyError, TypeError):
            pass
        if base['time'] is None:
            stamp = meta.get('updated_at')
            if isinstance(stamp, (int, float)) and stamp > 0:
                base.update(time=datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc).isoformat(), timeKind='metadata')
            else:
                base.update(time=datetime.datetime.fromtimestamp((index / 'meta.json').stat().st_mtime, datetime.timezone.utc).isoformat(), timeKind='mtime')
        return dict(base, state='ready', detail=tr("Index ready · {} files").format(meta.get('num_files', '?')), fingerprint=fp)
    except (OSError, ValueError, TypeError, OverflowError, AttributeError) as error:
        return dict(base, state='error', detail=str(error))


@contextlib.contextmanager
def locks(index, external, exclusive):
    handles = []
    try:
        # Deterministic ordering prevents deadlocks; nonblocking avoids a UI hang.
        paths = {str(index.parent / (index.name + '.tgrep-search.lock')), str(external)}
        for name in sorted(paths):
            handle = open(name, 'a')
            handles.append(handle)
            fcntl.flock(handle, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        yield
    finally:
        for handle in reversed(handles):
            handle.close()


class Cancelled(Exception):
    pass


def main():
    global _LANGUAGE
    request = json.loads(sys.stdin.readline())
    _LANGUAGE = 'ru' if str(request.get('language', 'en')).lower().split('-')[0] == 'ru' else 'en'
    root = Path(request['root']).expanduser().resolve()
    index = Path(request['index']).expanduser().resolve()
    op = request['op']
    external = Path(request.get('externalLock') or str(index.parent / (index.name + '-update.lock'))).expanduser().resolve()
    child = None

    def cancel(signum, frame):
        raise Cancelled()

    def watch_parent():
        # The extension keeps stdin open. EOF means host crash/disposal.
        sys.stdin.read()
        os.kill(os.getpid(), signal.SIGTERM)

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    threading.Thread(target=watch_parent, daemon=True).start()
    try:
        if not root.is_dir():
            raise ValueError(tr("The source folder does not exist"))
        if index == root or root in index.parents:
            raise ValueError(tr("Choose an index folder outside the source folder (prevents self-indexing)"))
        if op == 'build':
            index.parent.mkdir(parents=True, exist_ok=True)
        if not index.parent.exists():
            if op != 'status':
                raise ValueError(tr("Index not found. Click Build / update."))
            print(json.dumps(dict(root=str(root), index=str(index), state='missing', detail=tr("Index not found"), time=None, timeKind='unknown')))
            return 0
        with locks(index, external, op == 'build'):
            state = inspect(root, index)
            if op == 'status':
                print(json.dumps(state))
                return 0
            if op == 'build':
                if state['state'] == 'mismatch':
                    raise ValueError(state['detail'] + tr(". Choose another index folder."))
                if (index / 'serve.json').exists():
                    raise ValueError(tr("Cannot rebuild an index while serve.json is present"))
                # Never overwrite an unrelated directory merely selected in a picker.
                if index.exists() and any(index.iterdir()) and not (index / 'meta.json').exists() and not (index / DIRTY).exists():
                    raise ValueError(tr("The folder is not empty and has no tgrep metadata. Choose an empty folder."))
                if (index / 'meta.json').exists():
                    raw = json.loads((index / 'meta.json').read_text())
                    if not isinstance(raw.get('root_path'), str) or Path(raw['root_path']).resolve() != root:
                        raise ValueError(tr("Cannot verify the source folder of the existing index"))
                index.mkdir(parents=True, exist_ok=True)
                (index / DIRTY).write_text(json.dumps({'root': str(root), 'pid': os.getpid()}))
                args = ['index', str(root), '--hidden', '--exclude', '.git', '--index-path', str(index)]
            else:
                if state['state'] != 'ready':
                    raise ValueError(state['detail'])
                args = request['args']
            try:
                try:
                    child = subprocess.Popen([request['executable']] + args, cwd=str(root), stdin=subprocess.DEVNULL)
                except OSError as error:
                    raise ValueError(tr("Could not start tgrep: {}. Check tgrepSearch.executable.").format(error)) from error
                code = child.wait()
            finally:
                if child is not None and child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
            if op == 'build' and code == 0:
                final = inspect(root, index, allow_dirty=True)
                if final['state'] != 'ready':
                    raise ValueError(tr("The build finished, but index validation failed: ") + final['detail'])
                receipt = {'root': str(root), 'completedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'fingerprint': final['fingerprint']}
                temp = index / (RECEIPT + '.tmp')
                temp.write_text(json.dumps(receipt))
                temp.replace(index / RECEIPT)
                (index / DIRTY).unlink()
            elif op == 'search' and fingerprint(index) != state['fingerprint']:
                raise ValueError(tr("The index changed during the search. Results were discarded; search again."))
            return code
    except BlockingIOError:
        if op == 'status':
            print(json.dumps(dict(root=str(root), index=str(index), state='busy', detail=tr("Index busy: update or another process"), time=None, timeKind='unknown')))
            return 0
        print(tr("Index busy. Wait for the search / external update to finish."), file=sys.stderr)
        return 75
    except Cancelled:
        return 130
    except (OSError, ValueError, KeyError) as error:
        print('tgrep Search: ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
