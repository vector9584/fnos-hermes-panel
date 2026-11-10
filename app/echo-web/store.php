<?php
declare(strict_types=1);

function echo_revision(array $task): string {
    unset($task['web_revision']);
    return hash('sha256', json_encode($task, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
}

function echo_versions(array $value): array {
    if (isset($value['tasks'])) {
        $value['tasks'] = array_map(fn($t) => array_merge($t, ['web_revision' => echo_revision($t)]), $value['tasks']);
    }
    foreach (['task', 'child'] as $key) {
        if (isset($value[$key]) && is_array($value[$key])) $value[$key]['web_revision'] = echo_revision($value[$key]);
    }
    return $value;
}

function echo_read(): array {
    $raw = file_get_contents(DATA);
    if ($raw === false) throw new RuntimeException('无法读取任务文件，未新建空队列');
    $value = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    echo_validate($value);
    return [$raw, $value];
}

function echo_validate($data): void {
    if (!is_array($data) || !isset($data['tasks']) || !is_array($data['tasks']) || !is_int($data['seq'] ?? null)) {
        throw new RuntimeException('任务文件结构异常，未修改原文件');
    }
    $ids = [];
    foreach ($data['tasks'] as $task) {
        $id = $task['id'] ?? null;
        if (!is_int($id) || $id < 1 || isset($ids[$id]) || !in_array($task['status'] ?? '', STATUSES, true)) {
            throw new RuntimeException('任务标识或状态异常，未修改原文件');
        }
        $ids[$id] = $task;
    }
    if ($ids && max(array_keys($ids)) > $data['seq']) throw new RuntimeException('任务序号异常');
    foreach ($ids as $id => $task) {
        $seen = [$id => true];
        $parent = $task['parent'] ?? null;
        while ($parent) {
            if (isset($seen[$parent]) || !isset($ids[$parent])) throw new RuntimeException('任务层级异常');
            $seen[$parent] = true;
            $parent = $ids[$parent]['parent'] ?? null;
        }
    }
}

function echo_lock(bool $exclusive) {
    $handle = @fopen(DATA . '.lock', 'c');
    if (!$handle) $handle = @fopen(DATA . '.lock', 'r');
    if (!$handle) throw new RuntimeException('无法读取队列锁');
    $deadline = microtime(true) + 8;
    while (!flock($handle, ($exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB)) {
        if (microtime(true) >= $deadline) { fclose($handle); throw new RuntimeException('执行器正在保存，请稍后重试'); }
        usleep(50000);
    }
    return $handle;
}

function echo_write(string $path, string $bytes, int $mode): void {
    $handle = fopen($path, 'xb');
    if (!$handle) throw new RuntimeException('无法创建保存文件');
    try {
        if (!chmod($path, $mode)) throw new RuntimeException('保存文件权限失败');
        $offset = 0;
        while ($offset < strlen($bytes)) {
            $count = fwrite($handle, substr($bytes, $offset));
            if ($count === false || $count === 0) throw new RuntimeException('写入未完成');
            $offset += $count;
        }
        if (!fflush($handle)) throw new RuntimeException('刷新保存文件失败');
        if (function_exists('fsync') && !fsync($handle)) throw new RuntimeException('持久保存文件失败');
    } finally { fclose($handle); }
}

function mutate(callable $fn) {
    global $action, $id, $body;
    $lock = null; $tmp = null;
    try {
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST' || ($_SERVER['HTTP_X_ECHO_REQUEST'] ?? '') !== '1') {
            throw new RuntimeException('请刷新网页后提交操作');
        }
        if (isset($_SERVER['HTTP_ORIGIN'])) {
            $origin = parse_url($_SERVER['HTTP_ORIGIN']);
            $authority = ($origin['host'] ?? '') . (isset($origin['port']) ? ':' . $origin['port'] : '');
            if (strtolower($authority) !== strtolower($_SERVER['HTTP_HOST'] ?? '')) throw new RuntimeException('不接受其他站点的写入请求');
        }
        $request = $body['_request_id'] ?? '';
        if (!is_string($request) || !preg_match('/^[a-zA-Z0-9_-]{8,128}$/D', $request)) throw new RuntimeException('缺少操作标识，请刷新后重试');
        $fingerprint = hash('sha256', json_encode([$action, $id, $body], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
        $lock = echo_lock(true);
        [$raw, $data] = echo_read();
        $previous = $data['web_operations'][$request] ?? null;
        if ($previous) {
            if ($previous['fingerprint'] !== $fingerprint) throw new RuntimeException('操作已保存，请刷新后继续编辑');
            return $previous['result'];
        }
        if ($id) {
            $current = null;
            foreach ($data['tasks'] as $task) if ($task['id'] === $id) $current = $task;
            if (!$current) throw new RuntimeException('任务不存在');
            if (($body['_revision'] ?? '') !== echo_revision($current)) throw new RuntimeException('任务已被其他页面或执行器更新，请刷新后合并');
            if (($current['status'] === 'doing' || ($current['panel_run']['state'] ?? '') === 'running') && !in_array($action, ['cancel','recover'], true)) throw new RuntimeException('任务正在执行，不能覆盖执行状态');
            if (in_array($action, ['archive', 'drop'], true)) {
                $family = [$id];
                do {
                    $before = count($family);
                    foreach ($data['tasks'] as $task) if (in_array($task['parent'] ?? null, $family, true) && !in_array($task['id'], $family, true)) $family[] = $task['id'];
                } while (count($family) !== $before);
                foreach ($data['tasks'] as $task) {
                    if ($task['id'] !== $id && in_array($task['id'], $family, true) && in_array($task['status'], ['staged','pending','doing','review'], true)) throw new RuntimeException('还有未结束的子任务');
                }
            }
        }
        $result = $fn($data);
        echo_validate($data);
        $data['web_operations'][$request] = ['fingerprint' => $fingerprint, 'result' => $result, 'at' => date('c')];
        // Deployment provisions only this dedicated directory for www-data.
        $directory = defined('ECHO_TEST_BACKUPS') && PHP_SAPI === 'cli' ? ECHO_TEST_BACKUPS : '/vol1/@appdata/hermes-agent/panel-state/echo-web-backups';
        if (!is_dir($directory) && !mkdir($directory, 0700)) throw new RuntimeException('无法创建原文件备份');
        $backup = $directory . '/' . hash('sha256', $raw) . '.json';
        if (!file_exists($backup)) echo_write($backup, $raw, 0600);
        elseif (file_get_contents($backup) !== $raw) throw new RuntimeException('原文件备份校验失败');
        $tmp = DATA . '.web-' . bin2hex(random_bytes(12));
        echo_write($tmp, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), fileperms(DATA) & 0777);
        if (!rename($tmp, DATA)) throw new RuntimeException('原子保存失败');
        $tmp = null;
        return $result;
    } catch (Throwable $error) {
        // Release explicitly before out(): PHP exit does not run finally.
        if ($tmp && file_exists($tmp)) unlink($tmp);
        if ($lock) { flock($lock, LOCK_UN); fclose($lock); $lock = null; }
        out(['ok' => false, 'error' => $error->getMessage()], 409);
    } finally {
        if ($tmp && file_exists($tmp)) unlink($tmp);
        if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
    }
}

function read_only(): array {
    $lock = null;
    try { $lock = echo_lock(false); return echo_read()[1]; }
    catch (Throwable $error) {
        if ($lock) { flock($lock, LOCK_UN); fclose($lock); $lock = null; }
        out(['ok' => false, 'error' => '任务文件读取失败：' . $error->getMessage()], 503);
    } finally { if ($lock) { flock($lock, LOCK_UN); fclose($lock); } }
}
