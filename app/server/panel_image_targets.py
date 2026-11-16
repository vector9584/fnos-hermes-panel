#!/usr/bin/env python3
"""读取 config.yaml 的 image_gen 段，返回可用于生图的模型目标。

设计要点（2026-11-16）：
- **不写死模型名**。生图模型是自由填写的 —— 实测 `gpt-image-2` 并不在
  provider `custom_umv9igjvr7sj9` 的 models 列表里（那里只有 deepseek-flash /
  deepseek-v4-pro），它只借用该 provider 的 base_url 与 key。
  所以唯一真源是 `image_gen` 配置段，不能从 models 列表反推。
- 支持三种形态：
  1) image_gen.provider=custom + image_gen.custom.{provider_id, model}
  2) image_gen.model 顶层
  3) image_gen.targets = [{provider_id, model}, ...] 数组
- 输出 provider 的 base_url，方便前端展示与后续校验。

用法：python3 panel_image_targets.py /path/to/config.yaml
输出：{"ok":true,"plugin":"custom","targets":[{provider_id,model,label,base_url,source}]}
"""
import json
import sys


def load_yaml(path):
    try:
        import yaml
    except ImportError:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return yaml.safe_load(fh) or {}
    except Exception:
        return None


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少 config.yaml 路径"}, ensure_ascii=False))
        return
    cfg_path = sys.argv[1]
    cfg = load_yaml(cfg_path)
    if cfg is None:
        print(json.dumps({"ok": False, "error": "无法读取 config.yaml"}, ensure_ascii=False))
        return

    ig = cfg.get("image_gen") or {}
    if not isinstance(ig, dict):
        ig = {}
    plugin = str(ig.get("provider") or "").strip()

    providers = {}
    raw_providers = cfg.get("providers")
    # config.yaml 里 providers 是 **dict**（键=provider_id，值={name,base_url,models[]}），
    # 但 `/api/config` 接口返回的是数组。两种形态都收，别只认一种（2026-11-16 实测踩坑）。
    if isinstance(raw_providers, dict):
        for pid, val in raw_providers.items():
            if isinstance(val, dict):
                merged = dict(val)
                merged.setdefault("id", pid)
                providers[str(pid)] = merged
    elif isinstance(raw_providers, list):
        for p in raw_providers:
            if isinstance(p, dict) and p.get("id"):
                providers[str(p["id"])] = p

    found = []

    def add(provider_id, model, source):
        provider_id = str(provider_id or "").strip()
        model = str(model or "").strip()
        if not model:
            return
        for t in found:
            if t["provider_id"] == provider_id and t["model"] == model:
                return
        prov = providers.get(provider_id) or {}
        name = str(prov.get("name") or provider_id or plugin or "custom")
        found.append({
            "provider_id": provider_id,
            "model": model,
            "label": name + " · " + model,
            "base_url": str(prov.get("base_url") or ""),
            "source": source,
        })

    sec = ig.get(plugin) if plugin else None
    if isinstance(sec, dict):
        add(sec.get("provider_id"), sec.get("model"), "image_gen." + (plugin or "custom"))
    # 顶层兜底（image_gen.model）：provider_id 沿用上面那一节
    fallback_pid = sec.get("provider_id") if isinstance(sec, dict) else ""
    add(fallback_pid, ig.get("model"), "image_gen.model")
    # 数组形态
    for item in (ig.get("targets") or []):
        if isinstance(item, dict):
            add(item.get("provider_id"), item.get("model"), "image_gen.targets")

    print(json.dumps({
        "ok": True,
        "plugin": plugin,
        "targets": found,
        "provider_count": len(providers),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
