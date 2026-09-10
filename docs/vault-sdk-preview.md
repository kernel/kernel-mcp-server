# Vault SDK validation and release gate

**Do not merge or deploy this change until a stable Node SDK includes the new vault
provider configuration APIs.** `package.json` and `bun.lock` deliberately retain the
released `@onkernel/sdk` dependency. No staging dependency or generated SDK source
is shipped in this repository.

The locked SDK (`0.100.0`) cannot typecheck this change: it lacks
`vaultProviderConfigs`, its request types, and the imported Link wallet request
variant. Its version number is also used by the preview; the preview version
string is **not** evidence that the feature has been released.

## Validated contracts

- API source: `kernel/kernel` PR #3816, head
  `0b96b27cfe03b4c26e8a6c92b8ae7baeca54e77d`.
- Generated SDK: `kernel/kernel-node-sdk-staging`, commit
  `ae29b778cecc8aadbf1922c29cd1fcb0464f9ea6`, from `stlc/preview/pr-3816`.
- Reviewed the complete SDK diff: five new config endpoints, customer config
  references, imported Link grants, recovery states, and updated card lifecycle
  semantics. The latest API main merge changes no vault paths or schemas; the
  preview's vault exports and signatures match that head.
- Tests use the actual generated SDK with mocked HTTP transports. No provider
  enrollment, OAuth, payment, deployment, or production mutation is exercised.

## Reproduce against the exact preview

Use a disposable checkout of this MCP branch. The following local tarball override
changes `node_modules` only; do not deploy it or commit an SDK override.

1. Clone and verify the generated SDK (next to the MCP checkout):

   ```sh
   gh repo clone kernel/kernel-node-sdk-staging -- --depth=1 --branch stlc/preview/pr-3816
   cd kernel-node-sdk-staging
   git fetch origin ae29b778cecc8aadbf1922c29cd1fcb0464f9ea6 --depth=1
   git checkout --detach ae29b778cecc8aadbf1922c29cd1fcb0464f9ea6
   test "$(git rev-parse HEAD)" = ae29b778cecc8aadbf1922c29cd1fcb0464f9ea6
   ```

2. Build and pack the SDK using its own build script:

   ```sh
   bun install
   bun run build
   cd dist
   bun pm pack --filename /tmp/kernel-sdk-ae29b77.tgz
   ```

3. Install the tarball without saving dependency changes:

   ```sh
   cd ../../kernel-mcp-server
   bun install --frozen-lockfile
   bun add --no-save /tmp/kernel-sdk-ae29b77.tgz
   git diff --exit-code -- package.json bun.lock
   ```

   A tarball is used instead of `bun link`: Turbopack cannot resolve a linked SDK
   outside its project root with this repository's current configuration.

4. Validate locally:

   ```sh
   bun test
   bunx tsc --noEmit
   KERNEL_CLI_PROD_CLIENT_ID=build-test-prod \
   KERNEL_CLI_STAGING_CLIENT_ID=build-test-staging \
   KERNEL_CLI_DEV_CLIENT_ID=build-test-dev \
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k \
   NEXT_TELEMETRY_DISABLED=1 bun run build
   ```

   These dummy values satisfy build-time configuration only; they cannot be used
   for authentication. Without configuration, page-data collection fails on the
   pre-existing required OAuth client IDs. `bun run lint` is also pre-existingly
   unsupported because Next.js 16 removed `next lint`; check changed-file Prettier
   formatting instead.

5. Discard the disposable checkout after validation, or reinstall the locked SDK
   with `bun install --force --frozen-lockfile`. Verify its contents before using
   the checkout for anything else; the preview shares the stable version string.

## Before merging

Publish the stable SDK through its normal release process, then update this
repository's `@onkernel/sdk` dependency and lockfile to that **actual released
version**. Repeat tests, typecheck, and build with a clean frozen-lockfile install,
not the preview tarball. Recheck the generated signatures if the upstream API
changes. Coordinate availability of the new API routes before deploying the MCP
server. Until those steps are complete, the default dependency build is blocked;
the preview-backed build is for review and validation only.
