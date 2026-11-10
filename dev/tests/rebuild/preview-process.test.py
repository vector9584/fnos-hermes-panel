import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from preview_process import preview_command, preview_launcher, read_startup_line, stop_process_group


class PreviewStartup(unittest.TestCase):
    def test_launcher_uses_current_hermes_identity_without_nested_sudo(self):
        self.assertEqual(preview_launcher(username='hermes-agent', configured=None), [])
        self.assertEqual(preview_launcher(username='vector', configured=None), ['sudo', '-n', '-u', 'hermes-agent'])
        self.assertEqual(preview_launcher(username='hermes-agent', configured=''), [])
        self.assertEqual(preview_launcher(username='vector', configured='doas -u hermes-agent'), ['doas', '-u', 'hermes-agent'])
        self.assertEqual(preview_command(['cat', '/tmp/fixture'], username='vector'), ['sudo', '-n', '-u', 'hermes-agent', 'cat', '/tmp/fixture'])
        self.assertEqual(preview_command(['cat', '/tmp/fixture'], username='hermes-agent'), ['cat', '/tmp/fixture'])

    def test_reads_dynamic_port_handshake(self):
        process = subprocess.Popen(
            [sys.executable, '-c', "print('{\"port\":32145}')"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        self.assertEqual(read_startup_line(process, timeout=2), '{"port":32145}')
        process.wait(timeout=2)
        process.stdout.close()
        process.stderr.close()

    def test_reports_startup_error_after_exit(self):
        process = subprocess.Popen(
            [sys.executable, '-c', "import sys; print('bind failed', file=sys.stderr)"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        process.wait(timeout=2)
        with self.assertRaisesRegex(RuntimeError, 'bind failed'):
            read_startup_line(process, timeout=2)
        process.stdout.close()
        process.stderr.close()

    def test_times_out_when_child_never_announces_ready(self):
        process = subprocess.Popen(
            [sys.executable, '-c', 'import time; time.sleep(2)'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            with self.assertRaisesRegex(RuntimeError, '没有输出启动信息'):
                read_startup_line(process, timeout=0.05)
        finally:
            process.terminate()
            process.wait(timeout=2)
            process.stdout.close()
            process.stderr.close()

    def test_stops_group_child_after_launcher_exits(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'stopped'
            child = "import signal,sys,time,pathlib; signal.signal(signal.SIGTERM, lambda *_: (pathlib.Path(sys.argv[1]).write_text('stopped'), sys.exit(0))); time.sleep(30)"
            launcher = "import subprocess,sys; p=subprocess.Popen([sys.executable,'-c',sys.argv[2],sys.argv[1]]); print(p.pid,flush=True)"
            process = subprocess.Popen(
                [sys.executable, '-c', launcher, str(marker), child],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                start_new_session=True,
            )
            child_pid = int(process.stdout.readline())
            process.wait(timeout=2)
            time.sleep(0.05)
            stop_process_group(process, timeout=2)
            process.stdout.close()
            process.stderr.close()
            self.assertTrue(marker.exists(), f'child {child_pid} did not receive SIGTERM')


if __name__ == '__main__':
    unittest.main(verbosity=2)
