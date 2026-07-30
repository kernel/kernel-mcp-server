# Project Setup Guide

## Package Manager

**IMPORTANT: This project uses `bun` as the package manager. You MUST use `bun` for all dependency management operations.**

- **DO NOT** use `npm`, `yarn`, or `pnpm`
- **ALWAYS** use `bun install` to install dependencies
- **ALWAYS** use `bun add <package>` to add new dependencies
- **ALWAYS** use `bun remove <package>` to remove dependencies

The lock file is `bun.lock` - never commit changes from other package managers.

## Installing Dependencies

```bash
bun install
```

## Environment Setup

1. Copy the example environment file:

   ```bash
   cp .env.example .env.local
   ```

2. Fill in the required environment variables (values can be found in 1password > DevEnvVars > MCP section)

## Development

Start the development server:

```bash
bun run dev
```

The server runs on port 3002 by default.

## Build

Build the project for production:

```bash
bun run build
```

## Production

Start the production server:

```bash
bun run start
```

## Code Quality

### Linting

Run ESLint (via Next.js):

```bash
bun run lint
```

### Formatting

This project uses Prettier for code formatting.

Check formatting:

```bash
bun run format:check
```

Fix formatting issues:

```bash
bun run format
```

Prettier formats the following file types: `*.ts`, `*.js`, `*.json`, `*.md`

## Project Structure

- `src/` - Source code directory
- `public/` - Static assets
- `next.config.ts` - Next.js configuration
- `tsconfig.json` - TypeScript configuration

## Tech Stack

- **Framework**: Next.js 16
- **Language**: TypeScript
- **Styling**: Tailwind CSS 4
- **Authentication**: Clerk
- **Package Manager**: Bun (required)

## Cursor Cloud specific instructions

### Running commands

**Always use `make` targets instead of raw `bun` commands** to ensure 1Password (`op`) injects secrets from the `.env` file:

- `make dev` — start dev server (port 3002)
- `make build` — production build
- `make start` — start production server
- `make install` — install dependencies
- `make lint` — run linter

The `Makefile` wraps commands with `op run --env-file .env --` so that 1Password references (e.g., `op://DevServiceAccount/DevEnvVars/MCP/...`) in `.env` are resolved at runtime. The `OP_SERVICE_ACCOUNT_TOKEN` secret must be available in the environment for this to work.

### Lint caveat

`next lint` was removed in Next.js 16. The `bun run lint` / `make lint` script will fail with "Invalid project directory". This is a pre-existing codebase issue — the script in `package.json` needs to be updated to use ESLint directly. For now, use `bun run format:check` for code quality checks.

### Testing MCP tool calls locally

The MCP server supports API key authentication (non-JWT bearer tokens). To test locally:

```bash
# Start the server
make dev

# In another terminal, send MCP requests with curl:
curl -s -X POST http://localhost:3002/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0.0"}}}'
```

Key MCP methods: `initialize`, `tools/list`, `tools/call`, `resources/list`, `prompts/list`.

The `KERNEL_API_KEY` env var is passed as the Bearer token and forwarded to the Kernel SDK for API calls. The `search_docs` tool works without network restrictions; other tools (`manage_browsers`, etc.) require connectivity to the Kernel platform API.

### Required secrets

- `OP_SERVICE_ACCOUNT_TOKEN` — 1Password service account token for `op run` to resolve `.env` references
- `KERNEL_API_KEY` — Kernel platform API key for testing MCP tool calls

### Services overview

| Service | Required | Notes |
|---------|----------|-------|
| Next.js dev server (port 3002) | Yes | `make dev` — the MCP server itself |
| Clerk (SaaS) | Yes | OAuth 2.1 auth — config injected via `op run` |
| Redis | Yes | OAuth org-context storage — URL injected via `op run` |
| Kernel Platform API (SaaS) | Yes | Backend for all MCP tools — reached via SDK |
| Mintlify (SaaS) | Optional | Only for `search_docs` tool |
