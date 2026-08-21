#!/bin/bash
set -euo pipefail

key_dir=/run/kernel-mcp-benchmark
mkdir -p "$key_dir"
chmod 0700 "$key_dir"
printf '%s' "$KERNEL_API_KEY" >"$key_dir/api-key"
chmod 0600 "$key_dir/api-key"

/usr/local/bin/start-kernel-mcp-server
printf 'ready\n' >/logs/kernel-mcp/ready
rm -f /app/setup.sh
