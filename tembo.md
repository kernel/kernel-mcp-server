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
