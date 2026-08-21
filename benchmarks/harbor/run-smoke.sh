#!/bin/bash
set -euo pipefail

usage() {
  echo "usage: $0 <claude-code|codex> [job-name] [jobs-dir]" >&2
  exit 2
}

agent=${1:-}
[[ "$agent" == "claude-code" || "$agent" == "codex" ]] || usage

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
benchmark_dir="$repo_root/benchmarks/harbor"
image_env="$benchmark_dir/.image.env"
[[ -f "$image_env" ]] || {
  echo "Missing $image_env; run benchmarks/harbor/build-image.sh first" >&2
  exit 1
}

set -a
source "$image_env"
set +a

: "${KERNEL_MCP_BENCHMARK_API_KEY:?KERNEL_MCP_BENCHMARK_API_KEY is required}"
: "${KERNEL_MCP_BENCHMARK_PROJECT_ID:?KERNEL_MCP_BENCHMARK_PROJECT_ID is required}"

case "$agent" in
  claude-code)
    if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${ANTHROPIC_AUTH_TOKEN:-}" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
      echo "ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN is required" >&2
      exit 1
    fi
    if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${ANTHROPIC_AUTH_TOKEN:-}" && -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
      ANTHROPIC_AUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN
      CLAUDE_FORCE_OAUTH=1
      export ANTHROPIC_AUTH_TOKEN CLAUDE_FORCE_OAUTH
    fi
    model=${CLAUDE_BENCHMARK_MODEL:-claude-sonnet-5}
    version=${CLAUDE_BENCHMARK_VERSION:-2.1.238}
    ;;
  codex)
    : "${OPENAI_API_KEY:?OPENAI_API_KEY is required}"
    model=${CODEX_BENCHMARK_MODEL:-gpt-5.6-terra}
    version=0.120.0
    ;;
esac

if [[ -n "${HARBOR_BIN:-}" ]]; then
  harbor_command=("$HARBOR_BIN")
elif command -v uvx >/dev/null 2>&1; then
  harbor_command=(
    uvx
    --from "harbor==0.21.0"
    --with "harbor-hypeman==0.1.1"
    harbor
  )
else
  echo "uvx not found; install uv or set HARBOR_BIN" >&2
  exit 1
fi

job_name=${2:-${agent}-smoke-$(date -u +%Y%m%dT%H%M%SZ)}
jobs_dir=${3:-${HARBOR_JOBS_DIR:-/tmp/kernel-mcp-harbor-jobs}}
runtime_task=$(mktemp -d)
runtime_env=$(mktemp)
trap 'rm -rf "$runtime_task"; rm -f "$runtime_env"' EXIT

export KERNEL_MCP_BENCHMARK_IMAGE KERNEL_MCP_SOURCE_SHA
python3 "$benchmark_dir/prepare-task.py" "$runtime_task"

cat >"$runtime_env" <<EOF
KERNEL_MCP_BENCHMARK_IMAGE=$KERNEL_MCP_BENCHMARK_IMAGE
KERNEL_MCP_SOURCE_SHA=$KERNEL_MCP_SOURCE_SHA
KERNEL_MCP_BENCHMARK_API_KEY=$KERNEL_MCP_BENCHMARK_API_KEY
KERNEL_MCP_BENCHMARK_PROJECT_ID=$KERNEL_MCP_BENCHMARK_PROJECT_ID
KERNEL_API_BASE_URL=${KERNEL_API_BASE_URL:-https://api.onkernel.com}
KERNEL_PROJECT=${KERNEL_PROJECT:-}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN:-}
CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:-}
CLAUDE_FORCE_OAUTH=${CLAUDE_FORCE_OAUTH:-}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
EOF
chmod 0600 "$runtime_env"

mkdir -p "$jobs_dir"
timeout --signal=INT --kill-after=30s "${HARBOR_BENCHMARK_TIMEOUT:-10m}" \
  "${harbor_command[@]}" run \
  --path "$runtime_task" \
  --agent "$agent" \
  --model "$model" \
  --agent-kwarg "version=$version" \
  --mcp-config "$benchmark_dir/mcp/kernel.json" \
  --env harbor_hypeman:HypemanEnvironment \
  --env-file "$runtime_env" \
  --job-name "$job_name" \
  --jobs-dir "$jobs_dir" \
  --n-concurrent 1 \
  --max-retries 0 \
  --delete \
  --yes
