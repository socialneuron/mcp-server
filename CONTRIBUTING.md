# Contributing to @socialneuron/mcp-server

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/socialneuron/mcp-server.git
cd mcp-server
npm install
```

## Running Tests

```bash
npm test           # Run all tests once
npm run test:watch # Watch mode
npm run typecheck  # TypeScript type checking
```

## Building

```bash
npm run build:all  # Build both stdio and HTTP transports
```

## Code Style

- Strict TypeScript — no `any` types
- All new code must pass `npm run typecheck`
- All new features must include tests
- Follow existing patterns in `src/tools/` for new MCP tools

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new tool for X
fix: handle edge case in Y
docs: update README with Z
test: add tests for W
```

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Add tests for any new functionality
3. Ensure all tests pass (`npm test`)
4. Ensure types check (`npm run typecheck`)
5. Submit a PR with a clear description of the change

## Reporting Security Issues

Do **not** open a public issue for security vulnerabilities. See [SECURITY.md](./SECURITY.md) for responsible disclosure instructions.

## Developer Certificate of Origin

By contributing, you certify that your contribution is your original work and
you have the right to submit it under the MIT license. Please sign off your
commits: `git commit -s -m "your message"`.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
