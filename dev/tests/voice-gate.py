#!/usr/bin/env python3
"""voice-gate.py — 录音静音闸门（audioVoiceGate）的可复跑验证

改过 app/ui/index.html 的录音路径后跑这条：`python3 dev/tests/voice-gate.py`
退出码 0 = 闸门判别正确，1 = 回归。

两层，都是对着**运行中的面板**实测，不是纸面推断：
  A 函数级：Playwright 打开 http://127.0.0.1:8650/，调真 audioVoiceGate，喂真录音文件
  B 端到端：Chromium 假麦克风（--use-file-for-fake-audio-capture）喂音频，
            走真 startVoiceRecord('legacy') → stopVoiceRecord()，看 onstop 里到底放行还是拦下

素材：优先用 data/uploads/files 里的真录音（有人声的取最大、空录音取最小）；
找不到就用 ffmpeg 合成同指纹的样本（前 550ms 静音 + 一下削顶爆音 = 空录音指纹）。
"""
import glob, json, os, subprocess, sys, tempfile, shutil

HOME = "/vol1/@apphome/hermes-agent/data"
APP = "/vol1/@apphome/hermes-agent"          # 面板静态根：URL /data/... 映射到 $APP/data
PANEL = "http://127.0.0.1:8650/"
os.environ.setdefault("HOME", HOME)
if not os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
    for c in glob.glob(f"{HOME}/.cache/ms-playwright") + glob.glob("/root/.cache/ms-playwright"):
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = c
        break
from playwright.sync_api import sync_playwright

WORK = tempfile.mkdtemp(prefix="hermes-verify-voice-gate-")
REL = "data/tmp/" + os.path.basename(WORK)          # 面板能取到的相对路径
PUB = os.path.join(APP, REL)

JS_GATE = """async (url) => {
  if (typeof audioVoiceGate !== 'function') return {error: 'audioVoiceGate 未定义'};
  const r = await fetch(url);
  const blob = new Blob([await r.arrayBuffer()], {type: 'audio/webm'});
  return await new Promise(res => {
    const t0 = performance.now();
    audioVoiceGate(blob, g => res(Object.assign({ms: Math.round(performance.now() - t0)}, g)));
    setTimeout(() => res({error: '回调 8s 未返回'}), 8000);
  });
}"""

JS_ARM = """() => {
  window.__probe = {sent: 0, silent: 0, toasts: []};
  window.sendVoiceMessage = () => { window.__probe.sent++; };
  window.transcribeVoice  = () => { window.__probe.sent++; };
  window._voiceChatSilent = () => { window.__probe.silent++; };
  const t = window.toast;
  window.toast = (m, k) => { window.__probe.toasts.push(String(m)); return t ? t(m, k) : null; };
  return true;
}"""

JS_REC = """async () => {
  window.__probe.sent = 0; window.__probe.silent = 0; window.__probe.toasts = [];
  startVoiceRecord('legacy');
  await new Promise(r => setTimeout(r, 1800));
  stopVoiceRecord();
  await new Promise(r => setTimeout(r, 1200));
  return window.__probe;
}"""


def ff(args):
    subprocess.run(["ffmpeg", "-v", "error", "-y"] + args, check=True)


def synth_click(path):
    """空录音指纹：3s 数字静音 + 第 550ms 一个 5ms 削顶爆音"""
    ff(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "3",
        "-f", "lavfi", "-i", "aevalsrc='if(between(t,0.55,0.555),0.9*sin(2*PI*1500*t),0)':s=48000:d=3",
        "-filter_complex", "[0][1]amix=inputs=2:normalize=0", "-ac", "1", "-ar", "48000", path])


def synth_voice(path):
    """有人声的量级：0.3s 起持续 1.5s、包络起伏的带噪浊音"""
    ff(["-f", "lavfi", "-i",
        "aevalsrc='if(between(t,0.3,1.8),(0.25+0.15*sin(2*PI*3*t))*sin(2*PI*180*t))':s=48000:d=2.2",
        "-ac", "1", "-ar", "48000", path])


def to_webm(src, dst):
    ff(["-i", src, "-c:a", "libopus", "-b:a", "48k", dst])


def pick_real():
    """挑真录音：>90KB 当人声样本，<8KB 当空录音样本"""
    fs = glob.glob(f"{HOME}/uploads/files/*.webm")
    big = [f for f in fs if os.path.getsize(f) > 90_000]
    small = [f for f in fs if os.path.getsize(f) < 8_000]
    return (max(big, key=os.path.getsize) if big else None,
            min(small, key=os.path.getsize) if small else None)


def main():
    os.makedirs(PUB, exist_ok=True)
    big, small = pick_real()
    sp_webm, si_webm = f"{WORK}/speech.webm", f"{WORK}/silent.webm"
    if big:
        shutil.copy(big, sp_webm)
    else:
        synth_voice(f"{WORK}/v.wav"); to_webm(f"{WORK}/v.wav", sp_webm)
    if small:
        shutil.copy(small, si_webm)
    else:
        synth_click(f"{WORK}/c.wav"); to_webm(f"{WORK}/c.wav", si_webm)
    shutil.copy(sp_webm, PUB); shutil.copy(si_webm, PUB)
    print(f"素材: 人声={os.path.basename(big) if big else '合成'} "
          f"{os.path.getsize(sp_webm)}B, 空录音={os.path.basename(small) if small else '合成'} "
          f"{os.path.getsize(si_webm)}B")

    with sync_playwright() as p:
        b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        pg = b.new_page()
        pg.goto(PANEL, wait_until="domcontentloaded", timeout=25000)
        pg.wait_for_timeout(1200)
        a = {"speech": pg.evaluate(JS_GATE, f"/{REL}/speech.webm"),
             "silent": pg.evaluate(JS_GATE, f"/{REL}/silent.webm")}
        b.close()
        print("A 函数级:", json.dumps(a, ensure_ascii=False))

        e2e = {}
        for name, wav in (("silent_input", None), ("voice_input", "v")):
            fixture = f"{WORK}/{name}.wav"
            if wav:
                synth_voice(fixture)
            else:
                synth_click(fixture)
            b = p.chromium.launch(args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                f"--use-file-for-fake-audio-capture={fixture}",
                "--autoplay-policy=no-user-gesture-required"])
            pg = b.new_page()
            pg.goto(PANEL, wait_until="domcontentloaded", timeout=25000)
            pg.wait_for_timeout(1200)
            pg.evaluate(JS_ARM)
            e2e[name] = pg.evaluate(JS_REC)
            b.close()
        print("B 端到端:", json.dumps(e2e, ensure_ascii=False))

    shutil.rmtree(WORK, ignore_errors=True)

    ok = (a["speech"].get("ok") is True and a["silent"].get("ok") is False
          and e2e["silent_input"]["sent"] == 0
          and (e2e["silent_input"]["silent"] + e2e["silent_input"]["toasts"] and True)
          and e2e["voice_input"]["sent"] == 1)
    print("\n期望 A: speech ok=true / silent ok=false ｜ B: 静音 sent=0、人声 sent=1")
    print("判定:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
