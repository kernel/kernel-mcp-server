#!/bin/bash
# Run one ClawBench task or the full suite through the local Kernel MCP build.
#
# The script asks ClawBench to generate ordinary Harbor tasks, rewrites those
# tasks with prepare-task.py, then lets Harbor create one isolated Hypeman
# environment per trial and install the selected stock agent inside it.
set -euo pipefail

usage() {
  echo "usage: $0 <claude-code|codex> [task-id|all] [job-name] [jobs-dir]" >&2
  exit 2
}

agent=${1:-}
[[ "$agent" == "claude-code" || "$agent" == "codex" ]] || usage
task_id=${2:-v2-1134-chapter-finder-redcross}

harness_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
source_root=${KERNEL_MCP_BENCHMARK_SOURCE_ROOT:-$harness_root}
benchmark_dir="$harness_root/benchmarks/harbor"
image_env="$source_root/benchmarks/harbor/.image.env"
clawbench_repo=${CLAWBENCH_REPO:-$harness_root/../ClawBench}
clawbench_ref=${CLAWBENCH_REF:-c7feaa2435ca8115c0762c44e13885fe5adf3e98}

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
    model=${CODEX_BENCHMARK_MODEL:-gpt-5.6-luna}
    version=${CODEX_BENCHMARK_VERSION:-0.120.0}
    ;;
esac

harbor_version=${HARBOR_VERSION:-0.21.0}
harbor_hypeman_version=${HARBOR_HYPEMAN_VERSION:-0.1.2}

export KERNEL_API_KEY=$KERNEL_MCP_BENCHMARK_API_KEY
export KERNEL_BASE_URL=${KERNEL_BASE_URL:-https://api.onkernel.com}
export KERNEL_API_BASE_URL=${KERNEL_API_BASE_URL:-$KERNEL_BASE_URL}

curl --silent --show-error --fail-with-body \
  --retry 3 \
  --retry-all-errors \
  --header "Authorization: Bearer $KERNEL_API_KEY" \
  "${KERNEL_API_BASE_URL%/}/auth/context" |
  bun "$benchmark_dir/verify-project-scope.ts"

runtime_root=$(mktemp -d)
runtime_env=$(mktemp)
trap 'rm -rf "$runtime_root"; rm -f "$runtime_env"' EXIT

dataset="$runtime_root/dataset"
adapt_args=(
  --output-dir "$dataset"
  --browser-runtime kernel
  --browser-runtime-options '{"stealth": true}'
  --overwrite
)
if [[ "$task_id" != "all" ]]; then
  adapt_args+=(--task-ids "$task_id")
fi
uv --directory "$clawbench_repo" run clawbench-harbor-adapt "${adapt_args[@]}"

mapfile -t task_dirs < <(find "$dataset" -mindepth 1 -maxdepth 1 -type d | sort)
((${#task_dirs[@]} > 0)) || {
  echo "ClawBench did not generate tasks for $task_id" >&2
  exit 1
}

for task_dir in "${task_dirs[@]}"; do
  python3 "$benchmark_dir/clawbench/prepare-task.py" "$task_dir" \
    --image "$KERNEL_MCP_BENCHMARK_IMAGE" \
    --server-sha "$KERNEL_MCP_SOURCE_SHA" \
    --clawbench-sha "$clawbench_ref"
done

{
  printf 'KERNEL_API_KEY=%s\n' "$KERNEL_API_KEY"
  printf 'KERNEL_BASE_URL=%s\n' "$KERNEL_BASE_URL"
  printf 'KERNEL_API_BASE_URL=%s\n' "$KERNEL_API_BASE_URL"
  printf 'API_BASE_URL=%s\n' "$KERNEL_API_BASE_URL"
  printf 'PURELY_MAIL_API_KEY=%s\n' "$PURELY_MAIL_API_KEY"
  printf 'PURELY_MAIL_DOMAIN=%s\n' "$PURELY_MAIL_DOMAIN"
  printf 'CLAWBENCH_JUDGE_BASE_URL=%s\n' "${CLAWBENCH_JUDGE_BASE_URL:-}"
  printf 'CLAWBENCH_JUDGE_API_KEY=%s\n' "${CLAWBENCH_JUDGE_API_KEY:-}"
  printf 'CLAWBENCH_JUDGE_MODEL=%s\n' "${CLAWBENCH_JUDGE_MODEL:-deepseek-v4-pro}"
  printf 'CLAWBENCH_JUDGE_API_TYPE=%s\n' "${CLAWBENCH_JUDGE_API_TYPE:-openai-completions}"
} >"$runtime_env"

case "$agent" in
  claude-code)
    {
      printf 'ANTHROPIC_API_KEY=%s\n' "${ANTHROPIC_API_KEY:-}"
      printf 'ANTHROPIC_AUTH_TOKEN=%s\n' "${ANTHROPIC_AUTH_TOKEN:-}"
      printf 'ANTHROPIC_BASE_URL=%s\n' "${ANTHROPIC_BASE_URL:-}"
      printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "${CLAUDE_CODE_OAUTH_TOKEN:-}"
      printf 'CLAUDE_FORCE_OAUTH=%s\n' "${CLAUDE_FORCE_OAUTH:-false}"
    } >>"$runtime_env"
    ;;
  codex)
    printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY" >>"$runtime_env"
    ;;
esac
chmod 0600 "$runtime_env"

job_name=${3:-kernel-mcp-${agent}-${task_id}-$(date -u +%Y%m%dT%H%M%SZ)}
jobs_dir=${4:-${HARBOR_JOBS_DIR:-/tmp/kernel-mcp-clawbench-jobs}}
mkdir -p "$jobs_dir"

if [[ "$task_id" == "all" ]]; then
  default_timeout=6h
else
  default_timeout=40m
fi

timeout --signal=INT --kill-after=30s "${HARBOR_BENCHMARK_TIMEOUT:-$default_timeout}" \
  uvx --from "harbor==$harbor_version" --with "harbor-hypeman==$harbor_hypeman_version" harbor run \
  --path "$dataset" \
  --agent "$agent" \
  --model "$model" \
  --agent-kwarg "version=$version" \
  --env harbor_hypeman:HypemanEnvironment \
  --env-file "$runtime_env" \
  --job-name "$job_name" \
  --jobs-dir "$jobs_dir" \
  --n-concurrent "${HARBOR_N_CONCURRENT:-1}" \
  --max-retries "${HARBOR_MAX_RETRIES:-5}" \
  --retry-include APITimeoutError \
  --retry-include APIConnectionError \
  --retry-include RateLimitError \
  --retry-include InternalServerError \
  --retry-include ConnectionRefusedError \
  --retry-include ExecProtocolError \
  --delete \
  --yes
