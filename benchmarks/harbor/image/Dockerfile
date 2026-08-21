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
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global bun@1.3.3

WORKDIR /opt/kernel-mcp-server

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN KERNEL_CLI_PROD_CLIENT_ID=kernel-mcp-benchmark \
    KERNEL_CLI_STAGING_CLIENT_ID=kernel-mcp-benchmark \
    KERNEL_CLI_DEV_CLIENT_ID=kernel-mcp-benchmark \
    CLERK_SECRET_KEY=sk_test_kernel_mcp_benchmark_local_only \
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_YmVuY2htYXJrLmNsZXJrLmFjY291bnRzLmRldiQ \
    bun run build \
    && install -m 0755 benchmarks/harbor/bin/start-kernel-mcp-server /usr/local/bin/start-kernel-mcp-server \
    && install -m 0755 benchmarks/harbor/bin/kernel-mcp-local /usr/local/bin/kernel-mcp-local \
    && install -m 0755 benchmarks/harbor/bin/verify-smoke.py /usr/local/bin/verify-kernel-mcp-smoke \
    && install -m 0644 benchmarks/harbor/bin/mcp-telemetry-proxy.mjs /usr/local/lib/mcp-telemetry-proxy.mjs \
    && install -m 0644 benchmarks/harbor/image/source-sha /opt/kernel-mcp-server/SOURCE_SHA

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
