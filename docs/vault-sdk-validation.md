# Vault SDK validation

Vault provider configuration support uses the published `@onkernel/sdk` **0.101.0**.
`package.json` requires `^0.101.0`, and `bun.lock` pins the npm release. No staging
package, local tarball override, or generated SDK source is required.

## Validated contracts

The [v0.101.0 release](https://github.com/kernel/kernel-node-sdk/releases/tag/v0.101.0)
was published from commit `88e5ccf02ff0b653f8951d38a508a684fe12231b`.
Its generated vault resources match the previously validated preview at
`ae29b778cecc8aadbf1922c29cd1fcb0464f9ea6`: provider configuration CRUD, config
references, imported Link grants, recovery states, and card lifecycle semantics.

Tests use the installed release with mocked HTTP transports. No provider
enrollment, OAuth, payment, deployment, or production mutation is exercised.

## Reproduce validation

From a clean checkout:

```sh
bun install --frozen-lockfile
bun test
bunx tsc --noEmit
KERNEL_CLI_PROD_CLIENT_ID=build-test-prod \
KERNEL_CLI_STAGING_CLIENT_ID=build-test-staging \
KERNEL_CLI_DEV_CLIENT_ID=build-test-dev \
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k \
NEXT_TELEMETRY_DISABLED=1 bun run build
```

The dummy values satisfy build-time configuration only; they cannot be used for
authentication. Without configuration, page-data collection fails on the existing
required OAuth client IDs. The existing `next lint` script is unsupported on
Next.js 16; check changed-file Prettier formatting instead.

The stable-SDK merge gate is resolved. Deployment still requires the new vault API
routes to be available and the caller's vault entitlement to be enabled; local SDK
validation does not verify a deployed API's availability.
