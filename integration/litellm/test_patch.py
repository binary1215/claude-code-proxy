"""Source identity and installation guards; uses temporary copies only."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import patch_litellm


class PatchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="litellm-patch-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        spec = importlib.util.find_spec("litellm")
        installed = Path(spec.origin).resolve().parent.parent
        for relative, (expected, replacements) in patch_litellm.PATCHES.items():
            text = (installed / relative).read_text(encoding="utf-8")
            if patch_litellm.blob_id(text.encode()) != expected:
                for old, new in reversed(replacements):
                    self.assertEqual(text.count(new), 1)
                    text = text.replace(new, old, 1)
            self.assertEqual(patch_litellm.blob_id(text.encode()), expected)
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8", newline="\n")

    def run_patch(self, *arguments):
        return subprocess.run(
            [sys.executable, str(Path(patch_litellm.__file__)), "--root", str(self.root), *arguments],
            capture_output=True, text=True, check=False,
        )

    def snapshot(self):
        return {relative: (self.root / relative).read_bytes() for relative in patch_litellm.PATCHES}

    def test_application_is_exact_and_idempotent(self):
        original = self.snapshot()
        checked = self.run_patch("--check")
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertEqual(self.snapshot(), original)
        self.assertEqual(self.run_patch().returncode, 0)
        patched = self.snapshot()
        for relative, (_, replacements) in patch_litellm.PATCHES.items():
            expected = patch_litellm.patched_text(original[relative].decode(), replacements).encode()
            self.assertEqual(patched[relative], expected)
        repeated = self.run_patch()
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertIn("0 files", repeated.stdout)
        self.assertEqual(self.snapshot(), patched)

    def test_last_file_mismatch_prevents_all_writes(self):
        last = self.root / next(reversed(patch_litellm.PATCHES))
        last.write_bytes(last.read_bytes() + b"\n# Unreviewed source change\n")
        before = self.snapshot()
        result = self.run_patch()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Source identity mismatch", result.stderr)
        self.assertEqual(self.snapshot(), before)

    def test_shadow_extension_prevents_all_writes(self):
        source = self.root / next(iter(patch_litellm.PATCHES))
        source.with_suffix(".cp312-win_amd64.pyd").touch()
        before = self.snapshot()
        result = self.run_patch()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Compiled module shadows source", result.stderr)
        self.assertEqual(self.snapshot(), before)

    def test_committed_diff_is_reproducible(self):
        generated = self.root / "generated.patch"
        result = self.run_patch("--emit-diff", str(generated))
        self.assertEqual(result.returncode, 0, result.stderr)
        committed = Path(__file__).with_name("native-preservation.patch")
        self.assertEqual(generated.read_bytes(), committed.read_bytes())


if __name__ == "__main__":
    unittest.main(verbosity=2)
