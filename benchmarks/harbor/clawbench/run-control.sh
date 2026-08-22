#!/bin/bash
set -euo pipefail

usage() {
  echo "usage: $0 <claude-code|codex> [task-id] [job-name] [jobs-dir]" >&2
  exit 2
}

agent=${1:-}
[[ "$agent" == "claude-code" || "$agent" == "codex" ]] || usage
task_id=${2:-v2-1134-chapter-finder-redcross}

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
benchmark_dir="$repo_root/benchmarks/harbor"
image_env="$benchmark_dir/.image.env"
clawbench_repo=${CLAWBENCH_REPO:-$repo_root/../ClawBench}
clawbench_ref=${CLAWBENCH_REF:-6efb04e49efc44f36fa03c8be3bcdb3ef091434f}

[[ -f "$image_env" ]] || {
  echo "Missing $image_env; run benchmarks/harbor/build-image.sh first" >&2
  exit 1
}
[[ -d "$clawbench_repo/.git" || -f "$clawbench_repo/.git" ]] || {
  echo "ClawBench checkout not found at $clawbench_repo" >&2
  exit 1
}
git -C "$clawbench_repo" merge-base --is-ancestor "$clawbench_ref" HEAD || {
  echo "ClawBench checkout must contain $clawbench_ref" >&2
  exit 1
}

if [[ -f "$clawbench_repo/.env" ]]; then
  set -a
  source "$clawbench_repo/.env"
  set +a
fi
set -a
source "$image_env"
set +a

: "${KERNEL_MCP_BENCHMARK_API_KEY:?KERNEL_MCP_BENCHMARK_API_KEY is required}"
: "${KERNEL_MCP_BENCHMARK_PROJECT_ID:?KERNEL_MCP_BENCHMARK_PROJECT_ID is required}"
: "${PURELY_MAIL_API_KEY:?PURELY_MAIL_API_KEY is required}"
: "${PURELY_MAIL_DOMAIN:?PURELY_MAIL_DOMAIN is required}"

case "$agent" in
  claude-code)
    if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${ANTHROPIC_AUTH_TOKEN:-}" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
      echo "ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN is required" >&2
      exit 1
    fi
    if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${ANTHROPIC_AUTH_TOKEN:-}" ]]; then
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
    version=${CODEX_BENCHMARK_VERSION:-0.120.0}
    ;;
esac

runtime_root=$(mktemp -d)
runtime_env=$(mktemp)
trap 'rm -rf "$runtime_root"; rm -f "$runtime_env"' EXIT

dataset="$runtime_root/dataset"
uv --directory "$clawbench_repo" run clawbench-harbor-adapt \
  --output-dir "$dataset" \
  --task-ids "$task_id" \
  --browser-runtime kernel \
  --browser-runtime-options '{"stealth": false}' \
  --overwrite

task_dir=$(find "$dataset" -mindepth 1 -maxdepth 1 -type d | head -1)
[[ -n "$task_dir" ]] || {
  echo "ClawBench did not generate task $task_id" >&2
  exit 1
}

python3 "$benchmark_dir/clawbench/prepare-control.py" "$task_dir" \
  --image "$KERNEL_MCP_BENCHMARK_IMAGE" \
  --server-sha "$KERNEL_MCP_SOURCE_SHA" \
  --clawbench-sha "$clawbench_ref"

export KERNEL_API_KEY=$KERNEL_MCP_BENCHMARK_API_KEY
export KERNEL_BASE_URL=${KERNEL_BASE_URL:-https://api.onkernel.com}
export KERNEL_API_BASE_URL=${KERNEL_API_BASE_URL:-$KERNEL_BASE_URL}
export KERNEL_MCP_BENCHMARK_PROJECT_ID

cat >"$runtime_env" <<EOF
KERNEL_API_KEY=$KERNEL_API_KEY
KERNEL_BASE_URL=$KERNEL_BASE_URL
KERNEL_API_BASE_URL=$KERNEL_API_BASE_URL
KERNEL_MCP_BENCHMARK_PROJECT_ID=$KERNEL_MCP_BENCHMARK_PROJECT_ID
PURELY_MAIL_API_KEY=$PURELY_MAIL_API_KEY
PURELY_MAIL_DOMAIN=$PURELY_MAIL_DOMAIN
CLAWBENCH_JUDGE_BASE_URL=${CLAWBENCH_JUDGE_BASE_URL:-}
CLAWBENCH_JUDGE_API_KEY=${CLAWBENCH_JUDGE_API_KEY:-}
CLAWBENCH_JUDGE_MODEL=${CLAWBENCH_JUDGE_MODEL:-deepseek-v4-pro}
CLAWBENCH_JUDGE_API_TYPE=${CLAWBENCH_JUDGE_API_TYPE:-openai-completions}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN:-}
ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-}
CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:-}
CLAUDE_FORCE_OAUTH=${CLAUDE_FORCE_OAUTH:-false}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
EOF
chmod 0600 "$runtime_env"

job_name=${3:-kernel-mcp-${agent}-${task_id}-$(date -u +%Y%m%dT%H%M%SZ)}
jobs_dir=${4:-${HARBOR_JOBS_DIR:-/tmp/kernel-mcp-clawbench-jobs}}
mkdir -p "$jobs_dir"

timeout --signal=INT --kill-after=30s "${HARBOR_BENCHMARK_TIMEOUT:-40m}" \
  uvx --from "harbor==0.21.0" --with "harbor-hypeman==0.1.1" harbor run \
  --path "$dataset" \
  --agent "$agent" \
  --model "$model" \
  --agent-kwarg "version=$version" \
  --env harbor_hypeman:HypemanEnvironment \
  --env-file "$runtime_env" \
  --job-name "$job_name" \
  --jobs-dir "$jobs_dir" \
  --n-concurrent 1 \
  --max-retries 0 \
  --delete \
  --yes
