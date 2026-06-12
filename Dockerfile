# VoxBrush 声笔 —— 多阶段构建（针对国内网络优化：npmmirror + hf-mirror）
# ---------- 阶段 1：构建前端 ----------
FROM node:20-bookworm-slim AS client-build
WORKDIR /app/client
RUN npm config set registry https://registry.npmmirror.com
COPY client/package.json ./
RUN npm install --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---------- 阶段 2：服务端依赖（含 sherpa-onnx 原生模块） ----------
FROM node:20-bookworm-slim AS server-deps
WORKDIR /app/server
RUN npm config set registry https://registry.npmmirror.com
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ---------- 阶段 3：下载流式 ASR 模型（中英双语 Zipformer int8） ----------
FROM debian:bookworm-slim AS asr-model
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /models/asr
ARG ASR_REPO=csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20
# 优先 hf-mirror（国内），回退 huggingface / GitHub Releases
RUN set -eux; \
    for base in "https://hf-mirror.com/${ASR_REPO}/resolve/main" "https://huggingface.co/${ASR_REPO}/resolve/main"; do \
      ok=1; \
      for f in encoder-epoch-99-avg-1.int8.onnx decoder-epoch-99-avg-1.onnx joiner-epoch-99-avg-1.int8.onnx tokens.txt; do \
        curl -fL --retry 3 --connect-timeout 20 -o "$f" "$base/$f" || { ok=0; break; }; \
      done; \
      [ "$ok" = "1" ] && break || rm -f *.onnx tokens.txt; \
    done; \
    test -s encoder-epoch-99-avg-1.int8.onnx && test -s tokens.txt

# ---------- 阶段 4：运行时 ----------
FROM node:20-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app/server
COPY --from=server-deps /app/server/node_modules ./node_modules
COPY server/ ./
COPY --from=client-build /app/client/dist ./public
COPY --from=asr-model /models/asr ./models/asr
# sherpa-onnx 动态库路径
ENV LD_LIBRARY_PATH=/app/server/node_modules/sherpa-onnx-linux-x64:/app/server/node_modules/sherpa-onnx-linux-arm64
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
