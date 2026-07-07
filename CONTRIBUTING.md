# Contributing

Thanks for your interest in Faktura!

## Getting started

```bash
make build          # contracts (Odra/Rust) + agents (TypeScript) + web
make test           # everything CI runs: fmt, clippy, contract tests, typecheck, web build
```

See the [README](README.md) for architecture and the full command list, and
[DORAHACKS.md](DORAHACKS.md) for the on-chain evidence pack.

## Pull requests

1. Fork and create a feature branch.
2. Keep changes focused; add or update tests where behavior changes.
3. Run `make test` before opening the PR — CI runs the same steps.
4. Describe what changed and why in the PR body.

## Reporting bugs

Open a [GitHub issue](../../issues) with steps to reproduce, expected vs
actual behavior, and environment details. For security issues, see
[SECURITY.md](SECURITY.md).
