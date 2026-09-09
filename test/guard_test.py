import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('guard', Path(__file__).parents[1] / 'scripts' / 'guard.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve() / 'src'
        self.root.mkdir()
        self.index = Path(self.tmp.name).resolve() / 'index'
        self.index.mkdir()
        self.meta = dict(version=2, root_path=str(self.root), num_files=0, num_trigrams=0, complete=True, updated_at=1700000000)
        self.save()
        for name in ['index.bin', 'lookup.bin', 'files.bin']:
            (self.index / name).touch()
        self.save()

    def save(self):
        (self.index / 'meta.json').write_text(json.dumps(self.meta))

    def test_root_binding_is_validated(self):
        self.assertEqual(g.inspect(self.root, self.index)['state'], 'ready')
        self.assertEqual(g.inspect(self.root.parent, self.index)['state'], 'mismatch')
        alias = self.root.parent / 'alias'
        alias.symlink_to(self.root)
        self.meta['root_path'] = str(alias)
        self.save()
        self.assertEqual(g.inspect(self.root, self.index)['state'], 'ready')

    def test_incomplete_dirty_and_corrupt_are_blocked(self):
        self.meta['complete'] = False
        self.save()
        self.assertEqual(g.inspect(self.root, self.index)['state'], 'error')
        self.meta['complete'] = True
        self.save()
        (self.index / g.DIRTY).touch()
        self.assertEqual(g.inspect(self.root, self.index)['state'], 'error')
        (self.index / g.DIRTY).unlink()
        (self.index / 'lookup.bin').write_bytes(b'x')
        self.assertEqual(g.inspect(self.root, self.index)['state'], 'error')

    def test_exact_completion_expires_after_external_update(self):
        receipt = dict(root=str(self.root), completedAt='2026-01-01T00:00:00+00:00', fingerprint=g.fingerprint(self.index))
        (self.index / g.RECEIPT).write_text(json.dumps(receipt))
        self.assertEqual(g.inspect(self.root, self.index)['timeKind'], 'completed')
        self.meta['updated_at'] += 30
        self.save()
        state = g.inspect(self.root, self.index)
        self.assertEqual(state['timeKind'], 'metadata')
        self.assertNotEqual(state['time'], receipt['completedAt'])

    def test_missing_date_is_mtime_estimate_and_missing_index_has_no_time(self):
        del self.meta['updated_at']
        self.save()
        self.assertEqual(g.inspect(self.root, self.index)['timeKind'], 'mtime')
        (self.index / 'meta.json').unlink()
        self.assertIsNone(g.inspect(self.root, self.index)['time'])

    def test_same_external_flock_excludes_reader_and_writer(self):
        lock = self.index.parent / 'index-update.lock'
        with g.locks(self.index, lock, True):
            with self.assertRaises(BlockingIOError):
                with g.locks(self.index, lock, False):
                    pass
        with g.locks(self.index, lock, False):
            with g.locks(self.index, lock, False):
                pass
            with self.assertRaises(BlockingIOError):
                with g.locks(self.index, lock, True):
                    pass

    def test_server_metadata_blocks_disk_mode(self):
        (self.index / 'serve.json').write_text('{}')
        self.assertEqual(g.inspect(self.root, self.index)['state'], 'error')

if __name__ == '__main__':
    unittest.main()
