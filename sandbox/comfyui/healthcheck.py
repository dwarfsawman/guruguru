import json
import re
import urllib.request

import torch


if not torch.cuda.is_available():
    raise SystemExit("CUDA is unavailable")

with urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=5) as response:
    stats = json.load(response)
if not any(device.get("type") == "cuda" for device in stats.get("devices", [])):
    raise SystemExit("ComfyUI does not report a CUDA device")

with urllib.request.urlopen("http://127.0.0.1:8188/object_info", timeout=10) as response:
    object_info = json.load(response)
if not any("pulid" in name.lower() for name in object_info):
    raise SystemExit("PuLID custom nodes are not registered")

filenames = []
for node in object_info.values():
    for value in node.get("input", {}).get("required", {}).values():
        if isinstance(value, list) and value and isinstance(value[0], list):
            filenames.extend(str(name) for name in value[0])

patterns = (
    re.compile(r"(chroma|flux|anima).*\.(safetensors|gguf)$", re.I),
    re.compile(r"(t5|clip|qwen).*\.(safetensors|gguf|bin)$", re.I),
    re.compile(r"(vae|ae).*\.(safetensors|pt|bin)$", re.I),
)
if not all(any(pattern.search(name) for name in filenames) for pattern in patterns):
    raise SystemExit("Required image model choices are incomplete")
