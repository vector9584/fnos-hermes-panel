"""Bounded startup handshake for isolated browser preview processes."""
import os
import pwd
import shlex
import select
import signal
import subprocess
import time


def preview_launcher(username=None, configured=None):
    """Return a launcher that switches to hermes-agent only when needed."""
    if configured is None:
        configured = os.environ.get('HERMES_PREVIEW_LAUNCH')
    if configured is not None:
        return shlex.split(configured)
    if username is None:
        username = pwd.getpwuid(os.geteuid()).pw_name
    return [] if username == 'hermes-agent' else ['sudo', '-n', '-u', 'hermes-agent']


def preview_command(arguments, username=None, configured=None):
    """Run an isolated fixture operation as hermes-agent without nested sudo."""
    return preview_launcher(username, configured) + list(arguments)


def read_startup_line(process, timeout=15):
    ready, _, _ = select.select([process.stdout], [], [], timeout)
    if not ready:
        raise RuntimeError(f'预览服务 {timeout} 秒内没有输出启动信息；退出码：{process.poll()!r}')
    line = process.stdout.readline().strip()
    if line:
        return line
    error = process.stderr.read().strip() if process.poll() is not None else '进程仍运行但没有启动输出'
    raise RuntimeError('预览服务没有启动：' + (error or '没有启动输出'))


def stop_process_group(process, timeout=8):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=timeout)
    else:
        time.sleep(min(timeout, 0.25))
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
