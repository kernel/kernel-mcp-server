#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    source = Path(__file__).parent / "smoke"
    output = args.output.resolve()
    image = os.environ["KERNEL_MCP_BENCHMARK_IMAGE"]
    source_sha = os.environ["KERNEL_MCP_SOURCE_SHA"]

    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(source, output)

    config_path = output / "task.toml"
    config = config_path.read_text()
    config = config.replace("${KERNEL_MCP_BENCHMARK_IMAGE}", image)
    config = config.replace("${KERNEL_MCP_SOURCE_SHA}", source_sha)
    config_path.write_text(config)

    wrapper = Path(__file__).parent / "bin" / "kernel-mcp-local"
    runtime_wrapper = output / "steps" / "run" / "workdir" / "kernel-mcp-local"
    shutil.copy2(wrapper, runtime_wrapper)
    runtime_wrapper.chmod(0o755)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
