# Built by Harbor inside each trial's Kernel browser VM. The build context is
# the generated ClawBench task environment: ClawBench's runtime directories
# plus the benchmarked source tree under kernel-mcp-server/.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        jq \
        procps \
        python3 \
        redis-server \
        socat \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global bun@1.3.3 mcp-remote@0.1.38

COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /usr/local/bin/uv

WORKDIR /app/src
COPY runtime-server/ ./runtime-server/
COPY chrome-extension/ ./chrome-extension/
COPY shared/ ./shared/
COPY harbor/ ./harbor/
RUN chmod +x harbor/*.sh harbor/*.py \
    && cd runtime-server \
    && UV_PYTHON_PREFERENCE=only-system uv sync --frozen \
    && uv pip install --python .venv/bin/python fpdf2

WORKDIR /opt/kernel-mcp-server

COPY kernel-mcp-server/package.json kernel-mcp-server/bun.lock ./
RUN bun install --frozen-lockfile

COPY kernel-mcp-server/ ./
RUN KERNEL_CLI_PROD_CLIENT_ID=kernel-mcp-benchmark \
    KERNEL_CLI_STAGING_CLIENT_ID=kernel-mcp-benchmark \
    KERNEL_CLI_DEV_CLIENT_ID=kernel-mcp-benchmark \
    CLERK_SECRET_KEY=sk_test_kernel_mcp_benchmark_local_only \
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_YmVuY2htYXJrLmNsZXJrLmFjY291bnRzLmRldiQ \
    bun run build \
    && install -m 0755 benchmarks/harbor/bin/start-kernel-mcp-server /usr/local/bin/start-kernel-mcp-server \
    && install -m 0755 benchmarks/harbor/bin/kernel-mcp-local /usr/local/bin/kernel-mcp-local

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
