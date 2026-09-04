# Kernel SDK preview

`kernel-sdk-768cea122220150aacc33074ea00a1c0afaf879e.tgz` contains the unmodified build output of:

- Source: `kernel/kernel-node-sdk-staging`
- Preview branch: `stlc/preview/pr-3698`
- Pinned commit: `768cea122220150aacc33074ea00a1c0afaf879e`
- SHA-256: `2261b802bfee25e86bad3b601129c9046beff323500075ffa201c35b70e8bba4`

This prerelease provides the vault API. Its generated package version still reads `0.98.0`; the archive filename, commit, and digest identify the preview, not that version number. The source repository requires authentication and contains no built package. Vendoring the compiled archive lets public CI and contributors use `bun install --frozen-lockfile` without private GitHub access or SDK build scripts. The archive includes the SDK's Apache-2.0 license and source maps/sources, like its published package.

Replace this dependency and remove the archive when a released SDK includes the same API. Do not substitute the current released `0.98.0` package: it lacks these vault resources.

## Rebuild

Use Bun 1.3.3, Node 22, GNU tar, and gzip. Rebuilding requires read access to the source repository; ordinary MCP installation does not. These commands only read the SDK repository and build in a temporary directory.

```bash
mcp_root="$PWD"
sha=768cea122220150aacc33074ea00a1c0afaf879e
work=$(mktemp -d)
gh repo clone kernel/kernel-node-sdk-staging "$work/source" -- --depth=1 --no-checkout
git -C "$work/source" fetch --depth=1 origin "$sha"
mkdir "$work/build"
git -C "$work/source" archive "$sha" | tar -x -C "$work/build"
cd "$work/build"
bun install --ignore-scripts
bun run build
tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 \
  --numeric-owner --format=gnu --transform='s,^dist,package,' -cf - dist \
  | gzip -n > "$mcp_root/vendor/kernel-sdk-$sha.tgz"
sha256sum "$mcp_root/vendor/kernel-sdk-$sha.tgz"
```

The SDK build uses its pinned TypeScript 5.8.3 and `tsc-multi` 1.1.11. Bun imports the SDK's existing dependency lock during the temporary build; that temporary lockfile is not part of the MCP repository. Fixed archive ordering, ownership, and timestamps make the archive deterministic. No SDK source changes are applied.
