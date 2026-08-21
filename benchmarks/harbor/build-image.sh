#!/bin/bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

source_sha=$(git rev-parse HEAD)
source_sha_file=benchmarks/harbor/image/source-sha
build_log=$(mktemp)
trap 'rm -f "$source_sha_file" "$build_log"' EXIT

printf '%s\n' "$source_sha" >"$source_sha_file"

set +e
hypeman build \
  --file benchmarks/harbor/image/Dockerfile \
  --cpus 4 \
  --memory 8GB \
  --timeout 30m \
  . 2>&1 | tee "$build_log"
build_status=${PIPESTATUS[0]}
set -e

build_id=$(sed -n 's/^Build ID: //p' "$build_log" | tail -1)
if [[ -z "$build_id" ]]; then
  echo "Hypeman did not return a build ID" >&2
  exit 1
fi

image_ref="builds/$build_id"
if ((build_status != 0)); then
  echo "Build record failed; checking for a delayed ready image for up to 60 seconds" >&2
  image_ready=false
  for _ in $(seq 1 12); do
    if hypeman --format json image list | python3 -c '
import json
import sys

image_ref = sys.argv[1]
expected = {image_ref, f"docker.io/{image_ref}:latest"}
images = json.load(sys.stdin)
raise SystemExit(
    0
    if any(image.get("name") in expected and image.get("status") == "ready" for image in images)
    else 1
)
' "$image_ref"
    then
      image_ready=true
      break
    fi
    sleep 5
  done
  if [[ "$image_ready" != true ]]; then
    exit "$build_status"
  fi
fi

cat >benchmarks/harbor/.image.env <<EOF
KERNEL_MCP_BENCHMARK_IMAGE=$image_ref
KERNEL_MCP_SOURCE_SHA=$source_sha
EOF
chmod 0600 benchmarks/harbor/.image.env

printf 'Wrote benchmarks/harbor/.image.env for %s\n' "$image_ref"
