import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "release_runtime_rehearsal", ROOT / "dev/release-runtime-rehearsal.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReleaseRuntimeRehearsal(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="runtime-rehearsal-test-", dir="/private/tmp")
        self.root = Path(self.tmp.name)
        self.stage = self.root / "stage"
        self.stage.mkdir()
        self.addCleanup(self.tmp.cleanup)

    def write_stage(self, entries):
        rows = []
        for source, destination, content in entries:
            path = self.stage / destination
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            rows.append({
                "source": source,
                "destination": destination,
                "sha256": hashlib.sha256(content).hexdigest(),
                "bytes": len(content),
            })
        (self.stage / "RELEASE-MANIFEST.json").write_text(json.dumps({
            "schema": 1,
            "kind": "hermes-release-stage",
            "commit": "fixture-commit",
            "file_count": len(rows),
            "files": rows,
        }), encoding="utf-8")

    def test_rehearsal_rejects_non_temporary_paths(self):
        with self.assertRaises(ValueError):
            MODULE.rehearse(Path("/vol1/stage"), self.root / "work")
        with self.assertRaises(ValueError):
            MODULE.rehearse(self.stage, Path("/Volumes/ExData/work"))

    def test_rehearsal_requires_three_files_for_action_coverage(self):
        self.write_stage([
            ("app/server/monitor.js", "appcenter/server/monitor.js", b"monitor\n"),
            ("app/ui/index.html", "appcenter/ui/index.html", b"ui\n"),
        ])
        with self.assertRaisesRegex(ValueError, "at least three"):
            MODULE.rehearse(self.stage, self.root / "work")

    def test_rehearsal_publishes_and_restores_create_replace_keep(self):
        self.write_stage([
            ("app/server/monitor.js", "appcenter/server/monitor.js", b"monitor-new\n"),
            ("app/ui/index.html", "appcenter/ui/index.html", b"ui-new\n"),
            ("app/python/panel_config.py", "appcenter/hermes-src/panel_config.py", b"python-new\n"),
        ])
        report = MODULE.rehearse(self.stage, self.root / "work")
        self.assertEqual(report["candidate_commit"], "fixture-commit")
        self.assertEqual(report["actions_seeded"], {"create": 1, "replace": 1, "keep": 1})
        self.assertEqual(report["unlisted_files_preserved"], ["local/unlisted.txt"])
        self.assertTrue(report["publish_exact_match"])
        self.assertTrue(report["rollback_exact_match"])
        self.assertEqual(report["target_before_files"], report["restored_target_files"])
        self.assertEqual(report["target_before_tree_sha256"], report["restored_target_tree_sha256"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
