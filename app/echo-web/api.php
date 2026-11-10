<?php
/**
 * 回声站 · 任务卡 API
 *
 * 数据：/vol1/1000/飞牛文件/html/.acl/tasks/tasks.json
 *       该目录权限 1777、文件 666，是为了让 hermes-agent 用户（cron 里的 taskq.py）
 *       和 www-data（本文件）双向可写。.acl 本身 751，其他用户进不来。
 *
 * 用量：只读打开 hermes-agent 的 state.db 聚合 sessions 表，不写、不加锁。
 *
 * 鉴权：nginx auth_request 已经挡过一道，这里再确认 REMOTE_USER 非空。
 */
declare(strict_types=1);
date_default_timezone_set('Asia/Shanghai');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const DATA   = '/vol1/1000/飞牛文件/html/.acl/tasks/tasks.json';
const USAGEDB = '/vol1/@apphome/hermes-agent/data/state.db';
const BALANCE = '/vol1/1000/飞牛文件/html/.acl/tasks/balance.json';
const TYPES  = ['开发', '研究', '运维', '内容', '生活', '其他'];
const STATUSES = ['staged', 'pending', 'doing', 'review', 'done', 'failed', 'dropped'];

$user = $_SERVER['REMOTE_USER'] ?? '';
if ($user === '') {
    http_response_code(401);
    echo json_encode(['ok' => false, 'error' => '未登录'], JSON_UNESCAPED_UNICODE);
    exit;
}

function out(array $d, int $code = 200): void {
    http_response_code($code);
    echo json_encode(echo_versions($d), JSON_UNESCAPED_UNICODE);
    exit;
}

function blank(): array {
    return ['version' => 1, 'seq' => 0, 'last_run' => null, 'tasks' => []];
}

function ev(array &$t, string $kind, array $extra = []): void {
    if (!isset($t['events']) || !is_array($t['events'])) $t['events'] = [];
    $e = array_merge(['t' => date('c'), 'k' => $kind], $extra);
    if (!empty($e['text'])) $e['text'] = mb_substr((string)$e['text'], 0, 800);
    $t['events'][] = $e;
}

/** 待定的约定：问题一条、建议一条。缺一半就补兜底，页面上永远两块 */
function norm_decide(string $s): string {
    $s = trim($s);
    if ($s === '') return $s;
    if (mb_strpos(explode("\n", $s)[0], '问题') !== 0) $s = '问题：' . $s;
    if (mb_strpos($s, '建议') === false) $s .= "\n建议：按你的判断办";
    return $s;
}

/** 待定写成「问题：… / 建议：…」两行；这里只取建议那一半 */
function advice_of(string $decide): string {
    $a = '';
    foreach (preg_split('/\r?\n/', $decide) as $raw) {
        $s = trim((string)preg_replace('/^[·•\-*]\s*/u', '', $raw));
        if ($s === '') continue;
        if (preg_match('/^(建议|方案|对策)\s*[:：]\s*(.+)$/u', $s, $m)) {
            $a .= ($a === '' ? '' : "\n") . trim($m[2]);
        }
    }
    return $a;
}

/** 子任务要能独立被接手：cron 唤醒时只看这一条，父卡的目标和进度得跟着走。
 *  机器拿到的就是四段：目标 / 任务 / 已完成 / 未完成。 */
function fork_brief(array $p, string $want): string {
    $blk = function (array $xs): string {
        $xs = array_values(array_filter(array_map(fn($x) => trim((string)$x), $xs), 'strlen'));
        if (!$xs) return '· 无';
        return implode("\n", array_map(fn($x) => '· ' . mb_substr($x, 0, 160), $xs));
    };
    $done = $left = $did = [];
    foreach (($p['todos'] ?? []) as $x) {
        if (($x['s'] ?? '') === 'done') $done[] = (string)($x['c'] ?? '');
        else $left[] = (string)($x['c'] ?? '');
    }
    foreach (($p['entries'] ?? []) as $e) {
        if (($e['kind'] ?? '') === 'deliver') $did[] = mb_substr((string)($e['text'] ?? ''), 0, 120);
    }
    return "目标：" . (string)($p['title'] ?? '') . "\n"
         . "任务：" . $want . "\n"
         . "已完成：\n" . $blk(array_merge($done, $did)) . "\n"
         . "未完成：\n" . $blk(array_merge($left, [$want]));
}

/** 开一条子任务：呼号、标题跟着根卡走，父卡自己的条目一条不加。
 *  子任务还能再开子任务，拆解数在页面上逐层并到根卡。 */
function make_child(array &$d, array $p, string $want, string $origin): array {
    $now = date('c');
    $d['seq'] = (int)$d['seq'] + 1;
    $cid = (int)$d['seq'];
    $child = [
        'id' => $cid,
        'call' => (int)($p['call'] ?? $p['id']),
        'parent' => (int)$p['id'],
        'title' => (string)($p['title'] ?? ''),
        'type' => (string)($p['type'] ?? '其他'),
        'star' => (float)($p['star'] ?? 3),
        'priority' => (float)($p['star'] ?? 3),
        'detail' => fork_brief($p, $want),
        'status' => 'pending',
        'created' => $now, 'updated' => $now, 'attempts' => 0,
        'track' => false, 'tags' => $p['tags'] ?? [],
        'exec' => $p['exec'] ?? ['mode' => 'normal', 'iters' => 3, 'model' => ''],
        'todos' => [['c' => mb_substr($want, 0, 200), 's' => 'todo']],
        'entries' => [], 'events' => [],
        'replied_at' => null, 'claimed_at' => null, 'delivered_at' => null, 'archived_at' => null,
        'rounds' => 0,
    ];
    ev($child, 'created', ['text' => $want, 'note' => $origin, 'by' => 'web']);
    $d['tasks'][] = $child;
    return ['cid' => $cid, 'child' => $child];
}

require_once __DIR__ . '/store.php';

/** 校验并归一化用户可写字段。$partial=true 时只处理出现的键。 */
function clean(array $in, bool $partial, array &$err): array {
    $o = [];
    $has = fn(string $k) => array_key_exists($k, $in);

    if (!$partial || $has('title')) {
        $t = trim((string)($in['title'] ?? ''));
        if ($t === '') { $err[] = '标题必填'; }
        elseif (mb_strlen($t) > 120) { $err[] = '标题最多 120 字'; }
        else $o['title'] = $t;
    }
    if (!$partial || $has('type')) {
        $ty = trim((string)($in['type'] ?? ''));
        if (!in_array($ty, TYPES, true)) { $err[] = '类型必选'; }
        else $o['type'] = $ty;
    }
    if (!$partial || $has('star')) {
        $s = $in['star'] ?? null;
        $s = is_numeric($s) ? round(((float)$s) * 2) / 2 : 0;
        if ($s < 0 || $s > 5) { $err[] = '星级 0~5，半星一档'; }
        else $o['star'] = $s;
    }
    if (!$partial || $has('detail')) {
        $dt = trim((string)($in['detail'] ?? ''));
        /* 要求必填：只有标题我是真不知道要什么结果，跑一轮全靠猜，
           猜错了你还得重来一遍，不如一开始就逼一句 */
        if (mb_strlen($dt) > 4000) { $err[] = '任务要求最多 4000 字'; }
        elseif ($dt === '') { $err[] = '任务要求得写一句，光有标题我只能猜'; }
        else $o['detail'] = $dt;
    }
    if (!$partial || $has('track')) {
        $o['track'] = (bool)($in['track'] ?? false);
    }
    if (!$partial || $has('status')) {
        $st = (string)($in['status'] ?? '');
        // 页面只允许在 pending / staged 之间切；其余状态由 agent 回填
        if (!in_array($st, ['pending', 'staged'], true)) {
            if ($st !== '') $err[] = '页面只能切待办/暂存';
        } else {
            $o['status'] = $st;
        }
    }
    if (!$partial || $has('exec')) {
        $ex = is_array($in['exec'] ?? null) ? $in['exec'] : [];
        $mode = ($ex['mode'] ?? 'normal') === 'deep' ? 'deep' : 'normal';
        $iters = (int)($ex['iters'] ?? 3);
        if ($iters < 1 || $iters > 10) $iters = 3;
        $model = trim((string)($ex['model'] ?? ''));
        if (mb_strlen($model) > 120) $err[] = '执行模型名称最多120字';
        $o['exec'] = ['mode' => $mode, 'iters' => $iters, 'model' => $model];
    }
    return $o;
}

/** 每百万 token 的空闲价：[缓存命中, 未命中输入, 输出]（元）。高峰期 ×2。 */
/* 高峰时段：周一到周五 9-12、14-18（法定节假日没接，节假日会按高峰价算，比实际贵一倍） */
function is_peak_ts(int $ts): bool {
    $w = (int)date('w', $ts);
    $h = (int)date('G', $ts);
    return $w >= 1 && $w <= 5 && (($h >= 9 && $h < 12) || ($h >= 14 && $h < 18));
}

function price_of(string $model): array {
    $m = strtolower($model);
    if (strpos($m, 'pro') !== false)   return [0.15, 4.5, 13.5];
    if (strpos($m, 'flash') !== false) return [0.02, 1.0, 4.0];
    if (strpos($m, 'chat') !== false)  return [0.02, 1.0, 4.0];
    return [0.0, 0.0, 0.0];   // 非 DeepSeek 模型不计价，免得编个数
}

$action = $_GET['a'] ?? 'list';
$id     = isset($_GET['id']) ? (int)$_GET['id'] : 0;
$body   = [];
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = json_decode((string)file_get_contents('php://input'), true);
    if (!is_array($body)) $body = $_POST;
}

switch ($action) {
    case 'whoami':
        out(['ok' => true, 'user' => $user]);

    case 'list':
        $d = read_only();
        out(['ok' => true, 'tasks' => $d['tasks'], 'seq' => $d['seq'], 'last_run' => $d['last_run']]);

    case 'cancel':
    case 'recover':
    case 'retry':
        $res = mutate(function (array &$d) use ($action, $id) {
            foreach ($d['tasks'] as &$t) {
                if ($t['id'] !== $id) continue;
                if ($action === 'retry') {
                    if ($t['status'] !== 'failed' || (float)($t['star'] ?? 0) < 1) throw new RuntimeException('只有一星以上的失败任务可以重试');
                    $t['panel_previous_attempts'] = $t['attempts'] ?? 0;
                    $t['attempts'] = 0;
                    $t['status'] = 'pending';
                    ev($t, 'retry', ['text' => '手动加入待回信队列；原执行历史保留']);
                } else {
                    $run = $t['panel_run'] ?? [];
                    if (($run['state'] ?? '') !== 'running') throw new RuntimeException('该任务没有可操作的执行记录');
                    if ($action === 'cancel') {
                        $t['panel_cancel_requested'] = $t['panel_cancel_requested'] ?? date('c');
                        ev($t, 'cancel_requested', ['text' => '已请求取消，等待执行器停止；已有工具操作不会自动撤销']);
                    } else {
                        $owner = $run['owner'] ?? [];
                        $pid = $owner['pid'] ?? 0;
                        if (!is_int($pid) || $pid < 1) throw new RuntimeException('执行进程身份缺失，未修改状态');
                        $dead = false;
                        $stat = @file_get_contents('/proc/' . $pid . '/stat');
                        $boot = @file_get_contents('/proc/sys/kernel/random/boot_id');
                        if ($stat !== false && $boot !== false) {
                            $fields = preg_split('/\s+/', trim(substr($stat, strrpos($stat, ')') + 1)));
                            if (isset($fields[19])) $dead = trim($boot) !== ($owner['boot'] ?? '') || $fields[19] !== ($owner['start'] ?? '');
                        } elseif (function_exists('posix_kill') && !@posix_kill($pid, 0) && posix_get_last_error() === 3) $dead = true;
                        if (!$dead) throw new RuntimeException('尚不能证明执行进程已退出，未改变任务状态');
                        $t['panel_run']['state'] = 'interrupted';
                        $t['panel_run']['finished_at'] = date('c');
                        unset($t['panel_cancel_requested']);
                        if ($t['status'] === 'doing') { $t['status'] = 'failed'; $t['error'] = '执行进程已退出，请核对结果后手动重试'; }
                        ev($t, 'interrupted', ['text' => '确认原执行进程已退出，未自动重试']);
                    }
                }
                $t['updated'] = date('c');
                return $t;
            }
            throw new RuntimeException('任务不存在');
        });
        out(['ok' => true, 'task' => $res]);

    case 'create':
        $err = [];
        $c = clean($body, false, $err);
        if ($err) out(['ok' => false, 'error' => implode('；', $err)], 400);
        $task = mutate(function (array &$d) use ($c, $user) {
            $d['seq'] = (int)$d['seq'] + 1;
            $t = [
                'id'       => $d['seq'],
                'title'    => $c['title'],
                'type'     => $c['type'],
                'star'     => $c['star'],
                'detail'   => $c['detail'],
                /* 一星以下＝暂存，机制写死：取队列只看一星以上 */
                'status'   => $c['status'] ?? (((float)$c['star'] >= 1) ? 'pending' : 'staged'),
                'priority' => $c['star'],
                'tags'     => [$c['type']],
                'track'    => $c['track'] ?? false,
                'exec'     => $c['exec'] ?? ['mode' => 'normal', 'iters' => 3, 'model' => ''],
                'todos'    => [],
                'entries'  => [],
                'replied_at' => null,
                'rounds'   => 0,
                'deliver'  => '',
                'decide'   => '',
                'result'   => '',
                'error'    => '',
                'note'     => '',
                'created'  => date('c'),
                'updated'  => date('c'),
                'attempts' => 0,
                'source'   => 'web:' . $user,
                'events'   => [],
            ];
            ev($t, 'created', ['by' => 'web']);
            $d['tasks'][] = $t;
            return $t;
        });
        out(['ok' => true, 'task' => $task]);

    case 'update':
        if ($id <= 0) out(['ok' => false, 'error' => '缺少 id'], 400);
        $err = [];
        $c = clean($body, true, $err);
        if ($err) out(['ok' => false, 'error' => implode('；', $err)], 400);
        $res = mutate(function (array &$d) use ($id, $c) {
            $idx = -1;
            foreach ($d['tasks'] as $i => $t) {
                if ((int)$t['id'] === $id) { $idx = $i; break; }
            }
            if ($idx < 0) return null;
            $t = $d['tasks'][$idx];
            $old = $t['status'] ?? 'pending';
            if (!in_array($old, ['pending','staged'], true)) unset($c['status']);
            $before = $t;   // 留一份改动前的快照，日志要写清楚到底动了哪几个字段
            foreach ($c as $k => $v) $t[$k] = $v;
            if (isset($c['star'])) {
                $t['priority'] = $c['star'];
                /* 星级就是门禁：降到一星以下退回暂存，升到一星以上回队列 */
                if (in_array($t['status'] ?? '', ['staged', 'pending'], true)) {
                    $t['status'] = ((float)$c['star'] >= 1) ? 'pending' : 'staged';
                }
            }
            if (isset($c['type'])) $t['tags'] = [$c['type']];
            $now = date('c');
            $t['updated'] = $now;
            if (isset($t['decide'])) $t['decide'] = norm_decide((string)$t['decide']);
            if (isset($c['status']) && $c['status'] !== $old) {
                $st = $c['status'];
                /* 状态一动就自动打时间戳：
                   doing→开始处理，done/review→处理完，dropped→沉寂，pending→重新排队清掉收工时间 */
                if ($st === 'doing' && empty($t['claimed_at'])) $t['claimed_at'] = $now;
                if (($st === 'done' || $st === 'review') && empty($t['delivered_at'])) $t['delivered_at'] = $now;
                if ($st === 'dropped') $t['archived_at'] = $now;
                if ($st === 'pending') { $t['delivered_at'] = null; $t['archived_at'] = null; }
                ev($t, $st === 'staged' ? 'stage' : ($st === 'pending' ? 'unstage' : $st),
                   ['text' => (string)($t['result'] ?? '') ?: (string)($t['decide'] ?? '') ?: (string)($t['deliver'] ?? '')]);
            } else {
                /* 只写「改了卡片内容」等于没写：隔几天回来看根本不知道改了什么。
                   这里逐个字段比对，列出人话。 */
                $names = ['title' => '标题', 'detail' => '要求', 'star' => '星级',
                          'type' => '类型', 'deep' => '深入执行', 'model' => '模型', 'track' => '跟踪'];
                $chg = [];
                foreach ($c as $k => $v) {
                    if ($k === 'status' || $k === 'priority' || !isset($names[$k])) continue;
                    $ov = $before[$k] ?? null;
                    if (json_encode($ov) === json_encode($v)) continue;
                    $nm = $names[$k];
                    if ($k === 'title')      $chg[] = $nm . '改成「' . mb_substr((string)$v, 0, 24) . '」';
                    elseif ($k === 'detail') $chg[] = $nm . '改成「' . mb_substr(preg_replace('/\s+/', ' ', (string)$v), 0, 36) . '」';
                    elseif ($k === 'star')   $chg[] = $nm . '调到 ' . rtrim(rtrim(number_format((float)$v, 1), '0'), '.') . ' 星';
                    elseif ($k === 'track')  $chg[] = $nm . ((bool)$v ? '打开' : '关掉');
                    else                     $chg[] = $nm . '改成 ' . mb_substr(is_scalar($v) ? (string)$v : '', 0, 24);
                }
                $say = $chg ? ('改了 ' . implode('、', $chg)) : '保存了，内容没变';
                ev($t, 'edit', ['text' => $say, 'note' => mb_substr($say, 0, 80)]);
            }
            $d['tasks'][$idx] = $t;
            /* 子任务收工不往父卡塞条目：它嵌在父卡「待定」下面那一组里显示 */
            return $t;
        });
        if ($res === null) out(['ok' => false, 'error' => '任务不存在'], 404);
        out(['ok' => true, 'task' => $res]);

    /** 对「需决策」点头：带着批示重新入队 */
    /** 按建议执行 = fork 出一条新任务。
     *  呼号、标题、类型、星级跟着父卡走，要求换成建议原文（或你填的那句）。
     *  父卡把待定留进历史、收进已回信；子卡进待回信。子卡收工时结果回写父卡。 */
    case 'answer':
        if ($id <= 0) out(['ok' => false, 'error' => '缺少 id'], 400);
        $note = trim((string)($body['note'] ?? ''));
        $res = mutate(function (array &$d) use ($id, $note) {
            $pi = -1;
            foreach ($d['tasks'] as $i => $t) {
                if ((int)$t['id'] === $id) { $pi = $i; break; }
            }
            if ($pi < 0) return null;
            $p = $d['tasks'][$pi];
            if (($p['status'] ?? '') !== 'review') throw new RuntimeException('该任务已不在待定状态');
            $decide = trim((string)($p['decide'] ?? ''));
            $advice = advice_of($decide);
            $want = $note !== '' ? $note : ($advice !== '' ? $advice : $decide);
            if ($want === '') throw new RuntimeException('请写明子任务要求');
            $now = date('c');

            if (!isset($p['entries']) || !is_array($p['entries'])) $p['entries'] = [];
            /* 父卡只留自己那一条回信：待定与「开了新任务」都不再追加 ——
               子任务那一组嵌在待定的下面显示，父卡多写一句就成了两条回信 */
            $p['decide'] = '';
            $p['status'] = 'done';
            $p['updated'] = $now;
            if (empty($p['delivered_at'])) $p['delivered_at'] = $now;
            $mk = make_child($d, $p, $want, '按 #' . $p['id'] . ' 的待定 fork');
            ev($p, 'answer', ['text' => $want, 'note' => '按建议开出子任务 #' . $mk['cid']]);
            $d['tasks'][$pi] = $p;
            return ['task' => $p, 'child' => $mk['child']];
        });
        if ($res === null) out(['ok' => false, 'error' => '任务不存在'], 404);
        out(['ok' => true, 'task' => $res['task'], 'child' => $res['child']]);

    /** 取消 = 这条待定不办了：关掉它，不派生任务，也不占「待定」那一格 */
    case 'dismiss':
        if ($id <= 0) out(['ok' => false, 'error' => '缺少 id'], 400);
        $note = trim((string)($body['note'] ?? ''));
        $res = mutate(function (array &$d) use ($id, $note) {
            $pi = -1;
            foreach ($d['tasks'] as $i => $t) {
                if ((int)$t['id'] === $id) { $pi = $i; break; }
            }
            if ($pi < 0) return null;
            $p = $d['tasks'][$pi];
            $had = trim((string)($p['decide'] ?? ''));
            $now = date('c');
            if (!isset($p['entries']) || !is_array($p['entries'])) $p['entries'] = [];
            /* 从条目里摘掉待定，别留一条「pending」在那儿让页面继续弹处理 */
            // 待定原文属于历史，不因关闭待定而删除。
            $p['decide'] = '';
            $p['status'] = 'done';
            $p['updated'] = $now;
            if (empty($p['delivered_at'])) $p['delivered_at'] = $now;
            ev($p, 'drop', ['text' => ($note !== '' ? $note : $had) ?: '待定关了', 'note' => '取消待定，不办了']);
            $d['tasks'][$pi] = $p;
            return ['task' => $p];
        });
        if ($res === null) out(['ok' => false, 'error' => '任务不存在'], 404);
        out(['ok' => true, 'task' => $res['task']]);

    /** 追加 = 我认为你没完成：从这张卡再长一条子任务，可以一层层嵌套 */
    case 'spawn':
        if ($id <= 0) out(['ok' => false, 'error' => '缺少 id'], 400);
        $want = trim((string)($body['want'] ?? $body['note'] ?? ''));
        if ($want === '') out(['ok' => false, 'error' => '要写清楚哪件事没完成'], 400);
        $res = mutate(function (array &$d) use ($id, $want) {
            $pi = -1;
            foreach ($d['tasks'] as $i => $t) {
                if ((int)$t['id'] === $id) { $pi = $i; break; }
            }
            if ($pi < 0) return null;
            $p = $d['tasks'][$pi];
            $mk = make_child($d, $p, $want, '从 #' . $p['id'] . ' 追加');
            $p['updated'] = date('c');
            ev($p, 'append', ['text' => $want, 'note' => '追加子任务 #' . $mk['cid']]);
            $d['tasks'][$pi] = $p;
            return ['task' => $p, 'child' => $mk['child']];
        });
        if ($res === null) out(['ok' => false, 'error' => '任务不存在'], 404);
        out(['ok' => true, 'task' => $res['task'], 'child' => $res['child']]);

    /** 沉寂 = 归档。任务全部完成后收起来，往来记录里只留一条索引 */
    case 'archive':
        if ($id <= 0) out(['ok' => false, 'error' => '缺少 id'], 400);
        $res = mutate(function (array &$d) use ($id) {
            $idx = -1;
            foreach ($d['tasks'] as $i => $t) {
                if ((int)$t['id'] === $id) { $idx = $i; break; }
            }
            if ($idx < 0) return null;
            $t = $d['tasks'][$idx];
            $now = date('c');
            /* 归档 = 这一条到此为止，直接标完成，不再走「沉寂」那条路。
               同时把后台那次对话排进沉淀队列，等 worker 去读会话、写笔记 */
            /* 沉寂是终态：进「已沉寂」那一档，前端不再给追加入口 */
            $t['panel_before_archive'] = $t['status'];
            $t['status'] = 'dropped';
            $t['archived_at'] = $now;
            if (empty($t['replied_at'])) $t['replied_at'] = $t['delivered_at'] ?? ($t['updated'] ?? $now);
            /* 已经沉淀过的不重排 —— 同一篇笔记写第二遍没意义 */
            $sd = $t['sediment'] ?? null;
            $done = is_array($sd) && ($sd['status'] ?? '') === 'done' && !empty($sd['file']) && file_exists($sd['file']);
            if (!$done) $t['sediment'] = ['at' => $now, 'status' => 'pending'];
            $t['updated'] = $now;
            ev($t, 'archive', ['text' => '归档收工，后台那次对话排进沉淀队列']);
            $d['tasks'][$idx] = $t;
            /* 子任务沉寂也不往父卡塞条目 */
            return $t;
        });
        if ($res === null) out(['ok' => false, 'error' => '任务不存在'], 404);
        out(['ok' => true, 'task' => $res]);

    /** 追加：在沉寂/已回信的卡上接着提新要求，标题和呼号都不动 */
    case 'append':
        if ($id <= 0) out(['ok' => false, 'error' => '缺少 id'], 400);
        $detail = trim((string)($body['detail'] ?? ''));
        if ($detail === '') out(['ok' => false, 'error' => '追加内容不能空'], 400);
        $res = mutate(function (array &$d) use ($id, $detail) {
            foreach ($d['tasks'] as &$t) {
                if ((int)$t['id'] === $id) {
                    $t['detail'] = rtrim((string)($t['detail'] ?? '')) . "\n· 追加（" . date('m-d') . "）：" . $detail;
                    $t['status'] = 'pending';
                    $t['decide'] = '';
                    $t['replied_at'] = null;
                    $t['delivered_at'] = null;
                    $t['archived_at'] = null;
                    $t['updated'] = date('c');
                    ev($t, 'append', ['note' => mb_substr($detail, 0, 80)]);
                    return $t;
                }
            }
            return null;
        });
        if ($res === null) out(['ok' => false, 'error' => '任务不存在'], 404);
        out(['ok' => true, 'task' => $res]);

    case 'drop':
    case 'restore':
        if ($id <= 0) out(['ok' => false, 'error' => '缺少 id'], 400);
        $to = $action === 'drop' ? 'dropped' : 'pending';
        $res = mutate(function (array &$d) use ($id, $to) {
            foreach ($d['tasks'] as &$t) {
                if ((int)$t['id'] === $id) {
                    if ($to === 'pending' && $t['status'] !== 'dropped') throw new RuntimeException('任务未归档');
                    $t['status'] = $to === 'pending' ? ($t['panel_before_archive'] ?? 'staged') : $to;
                    if ($to === 'pending') $t['archived_at'] = null;
                    $t['updated'] = date('c');
                    ev($t, $to === 'dropped' ? 'drop' : 'restore');
                    return $t;
                }
            }
            return null;
        });
        if ($res === null) out(['ok' => false, 'error' => '任务不存在'], 404);
        out(['ok' => true, 'task' => $res]);

    case 'delete':
        out(['ok' => false, 'error' => '硬删除已停用，请归档并保留往来记录'], 410);

    case 'usage':
        $range = (string)($_GET['range'] ?? '');
        if ($range === 'year') {
            $since = strtotime(date('Y') . '-01-01 00:00:00');
            $days  = (int)ceil((time() - $since) / 86400) + 1;
        } else {
            $days = (int)($_GET['days'] ?? 30);
            if ($days < 1 || $days > 3650) $days = 30;
            $since = time() - $days * 86400;
        }
        if (!is_file(USAGEDB)) out(['ok' => false, 'error' => '用量库不存在'], 500);
        try {
            $pdo = new PDO('sqlite:' . USAGEDB, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $pdo->exec('PRAGMA busy_timeout=3000');
            $pdo->exec('PRAGMA temp_store=MEMORY');
            $sql = "select date(started_at,'unixepoch','+8 hours') d,
                           coalesce(model,'未标记') model,
                           coalesce(source,'?') src,
                           case when cast(strftime('%w', started_at,'unixepoch','+8 hours') as int) between 1 and 5
                                 and (cast(strftime('%H', started_at,'unixepoch','+8 hours') as int) between 9 and 11
                                   or cast(strftime('%H', started_at,'unixepoch','+8 hours') as int) between 14 and 17)
                                then 1 else 0 end peak,
                           sum(input_tokens) miss, sum(cache_read_tokens) hit,
                           sum(output_tokens) outp, sum(reasoning_tokens) rs,
                           sum(api_call_count) calls, count(*) n,
                           sum(estimated_cost_usd) est
                    from sessions
                    where started_at >= :s and coalesce(input_tokens,0)+coalesce(output_tokens,0)+coalesce(cache_read_tokens,0) > 0
                    group by d, model, src, peak
                    order by d";
            $st = $pdo->prepare($sql);
            $st->execute([':s' => $since]);
            $rows = $st->fetchAll(PDO::FETCH_ASSOC);
        } catch (Throwable $e) {
            out(['ok' => false, 'error' => '用量库读取失败：' . $e->getMessage()], 500);
        }

        $tot = ['cost' => 0.0, 'miss' => 0, 'hit' => 0, 'out' => 0, 'rs' => 0, 'calls' => 0, 'n' => 0,
                'unpriced_tok' => 0];
        $models = []; $srcs = []; $out = []; $unpriced = [];
        foreach ($rows as $r) {
            [$ph, $pm, $po] = price_of((string)$r['model']);
            $mult = ((int)$r['peak'] === 1) ? 2.0 : 1.0;
            $cost = (((int)$r['hit'] * $ph) + ((int)$r['miss'] * $pm) + ((int)$r['outp'] * $po)) / 1000000 * $mult;
            $tok = (int)$r['miss'] + (int)$r['hit'] + (int)$r['outp'];
            $priced = ($ph + $pm + $po) > 0;
            if (!$priced) {
                $tot['unpriced_tok'] += $tok;
                $u = $unpriced[$r['model']] ?? ['model' => $r['model'], 'tok' => 0, 'calls' => 0];
                $u['tok'] += $tok;
                $u['calls'] += (int)$r['n'];
                $unpriced[$r['model']] = $u;
            }
            $one = [
                'd' => $r['d'], 'model' => $r['model'], 'src' => $r['src'], 'peak' => (int)$r['peak'],
                'miss' => (int)$r['miss'], 'hit' => (int)$r['hit'], 'out' => (int)$r['outp'],
                'rs' => (int)$r['rs'], 'calls' => (int)$r['calls'], 'n' => (int)$r['n'],
                'cost' => round($cost, 6), 'priced' => $priced,
            ];
            $out[] = $one;
            $models[$r['model']] = true;
            $srcs[$r['src']] = true;
            $tot['cost'] += $cost;
            foreach (['miss', 'hit', 'out', 'rs', 'calls', 'n'] as $k) $tot[$k] += $one[$k];
        }
        $tot['cost'] = round($tot['cost'], 4);
        $unpriced = array_values($unpriced);
        usort($unpriced, fn($a, $b) => $b['tok'] <=> $a['tok']);

        out([
            'ok' => true,
            'days' => $days,
            'range' => $range === 'year' ? 'year' : (string)$days,
            'since' => date('Y-m-d', $since),
            'unit' => '人民币元，按 DeepSeek 官方价（空闲价×1、高峰×2）估算；不含 Search/Fetch 独立计费',
            'models' => array_keys($models),
            'sources' => array_keys($srcs),
            'unpriced' => $unpriced,
            'totals' => $tot,
            'rows' => $out,
            'generated_at' => date('Y-m-d H:i:s'),
        ]);

    /* 任意区间用量：from/to 定窗口，bucket 定刻度。
       原子桶是「小时」（sessions.started_at 是秒级时间戳），再合并成
       季度 / 月 / 周 / 天 / 小时。前端钻取＝换窗口，四张图共用这一份数据。
       周按周一起算；高峰与价格逐小时判，同一桶里跨 12 点也不会算错。 */
    case 'usage_range':
        $from = (string)($_GET['from'] ?? '');
        $to   = (string)($_GET['to'] ?? '');
        $bucket = (string)($_GET['bucket'] ?? 'day');
        if (!in_array($bucket, ['hour', 'day', 'week', 'month', 'quarter'], true)) $bucket = 'day';
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $from) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $to)) {
            out(['ok' => false, 'error' => 'from / to 应为 YYYY-MM-DD'], 400);
        }
        $s = strtotime($from . ' 00:00:00');
        $e = strtotime($to . ' 00:00:00') + 86400;
        if ($s === false || $e === false || $e <= $s) out(['ok' => false, 'error' => '区间无效'], 400);
        if ($e - $s > 366 * 86400 * 3) out(['ok' => false, 'error' => '区间太长'], 400);
        if (!is_file(USAGEDB)) out(['ok' => false, 'error' => '用量库不存在'], 500);

        try {
            $pdo = new PDO('sqlite:' . USAGEDB, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $pdo->exec('PRAGMA busy_timeout=3000');
            $pdo->exec('PRAGMA temp_store=MEMORY');
            $st = $pdo->prepare("select strftime('%Y-%m-%d %H', started_at,'unixepoch','+8 hours') b,
                                        coalesce(model,'未标记') model,
                                        coalesce(source,'?') src,
                                        sum(input_tokens) miss, sum(cache_read_tokens) hit,
                                        sum(output_tokens) outp, sum(reasoning_tokens) rs,
                                        sum(api_call_count) calls, count(*) n
                                 from sessions
                                 where started_at >= :s and started_at < :e
                                   and coalesce(input_tokens,0)+coalesce(output_tokens,0)+coalesce(cache_read_tokens,0) > 0
                                 group by b, model, src");
            $st->execute([':s' => $s, ':e' => $e]);
            $rows = $st->fetchAll(PDO::FETCH_ASSOC);
        } catch (Throwable $ex) {
            out(['ok' => false, 'error' => '用量库读取失败：' . $ex->getMessage()], 500);
        }

        /* 小时桶 -> 目标刻度的 key */
        $keyOf = function (string $hb) use ($bucket): string {
            $d = substr($hb, 0, 10);
            if ($bucket === 'hour') return $hb;
            if ($bucket === 'day')  return $d;
            if ($bucket === 'month') return substr($d, 0, 7);
            if ($bucket === 'quarter') {
                return substr($d, 0, 4) . '-Q' . (intdiv((int)substr($d, 5, 2) - 1, 3) + 1);
            }
            $ts = strtotime($d . ' 12:00:00');
            $w = (int)date('N', $ts);
            return date('Y-m-d', $ts - ($w - 1) * 86400);
        };
        $labelOf = function (string $k) use ($bucket): string {
            if ($bucket === 'hour')  return substr($k, 11, 2) . ':00';
            if ($bucket === 'day')   return substr($k, 5);
            if ($bucket === 'week')  return substr($k, 5);
            if ($bucket === 'month') return (int)substr($k, 5, 2) . ' 月';
            return substr($k, 5);
        };

        $agg = [];
        $byModel = [];
        $bySrc = [];
        $unpriced = [];
        $tot = ['miss' => 0, 'hit' => 0, 'out' => 0, 'rs' => 0, 'calls' => 0, 'n' => 0, 'cost' => 0.0];
        foreach ($rows as $r) {
            $hb = (string)$r['b'];
            $k  = $keyOf($hb);
            $hh = (int)substr($hb, 11, 2);
            $tsHour = strtotime(substr($hb, 0, 10) . sprintf(' %02d:00:00', $hh));
            [$ph, $pm, $po] = price_of((string)$r['model']);
            $mult = is_peak_ts((int)$tsHour + 60) ? 2.0 : 1.0;
            $cost = (((int)$r['hit'] * $ph) + ((int)$r['miss'] * $pm) + ((int)$r['outp'] * $po)) / 1000000 * $mult;
            if ($cost <= 0) $unpriced[(string)$r['model']] = true;

            if (!isset($agg[$k])) {
                $agg[$k] = ['key' => $k, 'label' => $labelOf($k),
                            'miss' => 0, 'hit' => 0, 'out' => 0, 'rs' => 0,
                            'calls' => 0, 'n' => 0, 'cost' => 0.0];
            }
            $a = &$agg[$k];
            $a['miss']  += (int)$r['miss'];
            $a['hit']   += (int)$r['hit'];
            $a['out']   += (int)$r['outp'];
            $a['rs']    += (int)$r['rs'];
            $a['calls'] += (int)$r['calls'];
            $a['n']     += (int)$r['n'];
            $a['cost']  += $cost;
            unset($a);

            $mn = (string)$r['model'];
            if (!isset($byModel[$mn])) $byModel[$mn] = ['name' => $mn, 'tok' => 0, 'cost' => 0.0, 'n' => 0];
            $byModel[$mn]['tok']  += (int)$r['miss'] + (int)$r['hit'] + (int)$r['outp'];
            $byModel[$mn]['cost'] += $cost;
            $byModel[$mn]['n']    += (int)$r['n'];

            $sn = (string)$r['src'];
            if (!isset($bySrc[$sn])) $bySrc[$sn] = ['name' => $sn, 'tok' => 0, 'cost' => 0.0, 'n' => 0];
            $bySrc[$sn]['tok']  += (int)$r['miss'] + (int)$r['hit'] + (int)$r['outp'];
            $bySrc[$sn]['cost'] += $cost;
            $bySrc[$sn]['n']    += (int)$r['n'];

            $tot['miss']  += (int)$r['miss'];
            $tot['hit']   += (int)$r['hit'];
            $tot['out']   += (int)$r['outp'];
            $tot['rs']    += (int)$r['rs'];
            $tot['calls'] += (int)$r['calls'];
            $tot['n']     += (int)$r['n'];
            $tot['cost']  += $cost;
        }

        /* 补齐空桶，x 轴才连续 */
        $keys = [];
        if ($bucket === 'hour') {
            for ($i = 0; $i < 24; $i++) $keys[] = $from . ' ' . sprintf('%02d', $i);
        } elseif ($bucket === 'day') {
            for ($t = $s; $t < $e; $t += 86400) $keys[] = date('Y-m-d', $t);
        } elseif ($bucket === 'week') {
            $w = (int)date('N', $s);
            $t = $s - ($w - 1) * 86400;
            while ($t < $e) { $keys[] = date('Y-m-d', $t); $t += 7 * 86400; }
        } elseif ($bucket === 'month') {
            $t = strtotime(date('Y-m-01', $s) . ' 00:00:00');
            while ($t < $e) { $keys[] = date('Y-m', $t); $t = strtotime('+1 month', $t); }
        } else {
            $q0 = intdiv((int)date('n', $s) - 1, 3) * 3;
            $t = strtotime(date('Y', $s) . '-' . sprintf('%02d', $q0 + 1) . '-01 00:00:00');
            while ($t < $e) {
                $keys[] = date('Y', $t) . '-Q' . (intdiv((int)date('n', $t) - 1, 3) + 1);
                $t = strtotime('+3 months', $t);
            }
        }

        $series = [];
        foreach ($keys as $k) {
            $a = $agg[$k] ?? ['key' => $k, 'label' => $labelOf($k),
                              'miss' => 0, 'hit' => 0, 'out' => 0, 'rs' => 0,
                              'calls' => 0, 'n' => 0, 'cost' => 0.0];
            $a['cost'] = round((float)$a['cost'], 6);
            $series[] = $a;
        }
        $tot['cost'] = round($tot['cost'], 4);
        $tot['tok'] = $tot['miss'] + $tot['hit'] + $tot['out'];

        $bm = array_values($byModel);
        usort($bm, fn($a, $b) => $b['tok'] <=> $a['tok']);
        foreach ($bm as &$x) $x['cost'] = round($x['cost'], 6);
        unset($x);
        $bs = array_values($bySrc);
        usort($bs, fn($a, $b) => $b['tok'] <=> $a['tok']);
        foreach ($bs as &$x) $x['cost'] = round($x['cost'], 6);
        unset($x);

        $children = ['hour' => null, 'day' => 'hour', 'week' => 'day', 'month' => 'week', 'quarter' => 'month'];

        out([
            'ok' => true,
            'from' => $from,
            'to' => $to,
            'bucket' => $bucket,
            'child' => $children[$bucket] ?? null,   // 下一层刻度，前端钻取用
            'unit' => '人民币元，按 DeepSeek 官方价（空闲×1、高峰×2）；不含 Search/Fetch',
            'unpriced' => array_keys($unpriced),
            'series' => $series,
            'totals' => $tot,
            'by_model' => $bm,
            'by_src' => $bs,
            'generated_at' => date('Y-m-d H:i:s'),
        ]);

    /* 账户余额：读 hermes-agent 侧 tick 刷出来的缓存。
       这里不碰 API key —— .env 是 600 hermes-agent，www-data 读不到也不该读。 */
    case 'balance':
        if (!is_file(BALANCE)) out(['ok' => true, 'balance' => null, 'stale' => true]);
        $raw = @file_get_contents(BALANCE);
        $b = json_decode((string)$raw, true);
        if (!is_array($b)) out(['ok' => true, 'balance' => null, 'stale' => true]);
        $b['age'] = time() - (int)@filemtime(BALANCE);
        out(['ok' => true, 'balance' => $b, 'stale' => ($b['age'] ?? 0) > 900]);

    /* 某一天的细账：小时桶 + 会话清单。
       粒度边界：sessions.started_at 是秒级，能答「哪个会话、几点几分开始、花了多少」；
       再细到单次 API 调用就没有时间戳了 —— 表里只有 api_call_count 这个计数。 */
    case 'usage_day':
        $day = (string)($_GET['day'] ?? '');
        if (!preg_match('/^\\d{4}-\\d{2}-\\d{2}$/', $day)) out(['ok' => false, 'error' => '日期格式应为 YYYY-MM-DD'], 400);
        $s = strtotime($day . ' 00:00:00');
        if ($s === false) out(['ok' => false, 'error' => '日期无效'], 400);
        $e = $s + 86400;
        if (!is_file(USAGEDB)) out(['ok' => false, 'error' => '用量库不存在'], 500);
        try {
            $pdo = new PDO('sqlite:' . USAGEDB, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $pdo->exec('PRAGMA busy_timeout=3000');
            $st = $pdo->prepare("select strftime('%H', started_at,'unixepoch','+8 hours') h,
                                        coalesce(model,'未标记') model,
                                        sum(input_tokens) miss, sum(cache_read_tokens) hit,
                                        sum(output_tokens) outp, sum(api_call_count) calls, count(*) n
                                 from sessions
                                 where started_at >= :s and started_at < :e
                                   and coalesce(input_tokens,0)+coalesce(output_tokens,0)+coalesce(cache_read_tokens,0) > 0
                                 group by h, model order by h");
            $st->execute([':s' => $s, ':e' => $e]);
            $hrows = $st->fetchAll(PDO::FETCH_ASSOC);

            $st2 = $pdo->prepare("select id, started_at, coalesce(model,'未标记') model, coalesce(source,'?') src,
                                         coalesce(input_tokens,0) miss, coalesce(cache_read_tokens,0) hit,
                                         coalesce(output_tokens,0) outp, coalesce(reasoning_tokens,0) rs,
                                         coalesce(api_call_count,0) calls
                                  from sessions
                                  where started_at >= :s and started_at < :e
                                    and coalesce(input_tokens,0)+coalesce(output_tokens,0)+coalesce(cache_read_tokens,0) > 0
                                  order by started_at");
            $st2->execute([':s' => $s, ':e' => $e]);
            $srows = $st2->fetchAll(PDO::FETCH_ASSOC);
        } catch (Throwable $ex) {
            out(['ok' => false, 'error' => '用量库读取失败：' . $ex->getMessage()], 500);
        }

        $hours = [];
        for ($i = 0; $i < 24; $i++) {
            $hh = sprintf('%02d', $i);
            $hours[$hh] = ['h' => $hh, 'miss' => 0, 'hit' => 0, 'out' => 0, 'calls' => 0, 'n' => 0, 'cost' => 0.0];
        }
        $models = [];
        foreach ($hrows as $r) {
            $hh = (string)$r['h'];
            [$ph, $pm, $po] = price_of((string)$r['model']);
            $mult = is_peak_ts($s + ((int)$hh) * 3600 + 60) ? 2.0 : 1.0;
            $cost = (((int)$r['hit'] * $ph) + ((int)$r['miss'] * $pm) + ((int)$r['outp'] * $po)) / 1000000 * $mult;
            $hours[$hh]['miss'] += (int)$r['miss'];
            $hours[$hh]['hit'] += (int)$r['hit'];
            $hours[$hh]['out'] += (int)$r['outp'];
            $hours[$hh]['calls'] += (int)$r['calls'];
            $hours[$hh]['n'] += (int)$r['n'];
            $hours[$hh]['cost'] += $cost;
            $models[(string)$r['model']] = true;
        }
        foreach ($hours as $hk => $hv) $hours[$hk]['cost'] = round($hv['cost'], 6);

        $sess = [];
        $tot = ['miss' => 0, 'hit' => 0, 'out' => 0, 'calls' => 0, 'n' => 0, 'cost' => 0.0];
        foreach ($srows as $r) {
            [$ph, $pm, $po] = price_of((string)$r['model']);
            $pk = is_peak_ts((int)$r['started_at']);
            $cost = (((int)$r['hit'] * $ph) + ((int)$r['miss'] * $pm) + ((int)$r['outp'] * $po)) / 1000000 * ($pk ? 2.0 : 1.0);
            $one = [
                'id' => $r['id'],
                'ts' => (int)$r['started_at'],
                'at' => date('H:i:s', (int)$r['started_at']),
                'hh' => date('H', (int)$r['started_at']),
                'model' => $r['model'], 'src' => $r['src'],
                'miss' => (int)$r['miss'], 'hit' => (int)$r['hit'], 'out' => (int)$r['outp'],
                'rs' => (int)$r['rs'], 'calls' => (int)$r['calls'],
                'tok' => (int)$r['miss'] + (int)$r['hit'] + (int)$r['outp'],
                'cost' => round($cost, 6),
                'peak' => $pk,
            ];
            $sess[] = $one;
            foreach (['miss', 'hit', 'out', 'calls'] as $k) $tot[$k] += $one[$k];
            $tot['n']++;
            $tot['cost'] += $cost;
        }
        $tot['cost'] = round($tot['cost'], 4);
        usort($sess, function ($a, $b) { return $b['ts'] <=> $a['ts']; });

        out([
            'ok' => true,
            'day' => $day,
            'hours' => array_values($hours),
            'sessions' => $sess,
            'totals' => $tot,
            'models' => array_keys($models),
            'unit' => '人民币元，按 DeepSeek 官方价（空闲×1、高峰×2）估算',
        ]);

    default:
        out(['ok' => false, 'error' => '未知操作'], 400);
}
