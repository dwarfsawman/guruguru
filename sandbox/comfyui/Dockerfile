FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04

ARG COMFYUI_COMMIT=f3a36e74844893f32f77f22d249d08862805d8f4
ARG PULID_COMMIT=52dc5068e0fc304e51273cfa5fbdd031e1ddb824

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_LINK_MODE=copy \
    PATH=/opt/venv/bin:/root/.local/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl git libgl1 libglib2.0-0 libgomp1 build-essential python3-dev \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && uv python install 3.11 \
    && uv venv --python 3.11 /opt/venv \
    && git clone https://github.com/comfyanonymous/ComfyUI.git /opt/ComfyUI \
    && git -C /opt/ComfyUI checkout "$COMFYUI_COMMIT" \
    && git clone https://github.com/PaoloC68/ComfyUI-PuLID-Flux-Chroma.git /opt/ComfyUI/custom_nodes/ComfyUI-PuLID-Flux-Chroma \
    && git -C /opt/ComfyUI/custom_nodes/ComfyUI-PuLID-Flux-Chroma checkout "$PULID_COMMIT" \
    && uv pip install --python /opt/venv/bin/python \
      torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128 \
    && uv pip install --python /opt/venv/bin/python -r /opt/ComfyUI/requirements.txt \
    && if [ -f /opt/ComfyUI/custom_nodes/ComfyUI-PuLID-Flux-Chroma/requirements.txt ]; then \
         uv pip install --python /opt/venv/bin/python -r /opt/ComfyUI/custom_nodes/ComfyUI-PuLID-Flux-Chroma/requirements.txt; \
       fi \
    && apt-get purge -y --auto-remove build-essential python3-dev \
    && rm -rf /var/lib/apt/lists/* /root/.cache /opt/ComfyUI/.git /opt/ComfyUI/custom_nodes/ComfyUI-PuLID-Flux-Chroma/.git

RUN uv pip uninstall --python /opt/venv/bin/python onnxruntime onnxruntime-gpu \
    && uv pip install --python /opt/venv/bin/python "onnxruntime-gpu==1.22.0" \
    && rm -rf /root/.cache

COPY comfyui/extra_model_paths.yaml /opt/sandbox-extra-model-paths.yaml
COPY comfyui/healthcheck.py /opt/healthcheck.py
RUN mkdir -p /data/input /data/output /data/temp /data/user

WORKDIR /opt/ComfyUI
EXPOSE 8188
CMD ["python", "main.py", "--listen", "0.0.0.0", "--port", "8188", "--input-directory", "/data/input", "--output-directory", "/data/output", "--temp-directory", "/data/temp", "--user-directory", "/data/user", "--database-url", "sqlite:////data/user/comfyui.db", "--extra-model-paths-config", "/opt/sandbox-extra-model-paths.yaml", "--disable-api-nodes"]
