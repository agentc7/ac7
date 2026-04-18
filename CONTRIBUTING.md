# Contributing to AgentC7

Thanks for your interest in AgentC7. This doc covers how to contribute
in a way that keeps the project legally clean and easy to work with.

## Before you start

- Read the [Code of Conduct](CODE_OF_CONDUCT.md). By participating you
  agree to uphold it.
- For **security issues**, please don't open a public issue — see
  [SECURITY.md](SECURITY.md).
- For questions or ideas, open a
  [discussion](https://github.com/agentc7/ac7/discussions) before
  investing in code. A quick back-and-forth saves a lot of wasted work.

## Development setup

```bash
git clone git@github.com:agentc7/ac7.git
cd ac7
pnpm install
pnpm build
pnpm test
```

Node 22+ and pnpm 10+ are required (see `.nvmrc`).

Useful per-package scripts:

```bash
pnpm --filter @agentc7/server dev      # run the broker with hot reload
pnpm --filter @agentc7/web dev         # run the PWA dev server
pnpm lint                              # biome check across the monorepo
pnpm typecheck                         # tsc --noEmit everywhere
pnpm test                              # all package test suites
```

## Contribution workflow

1. **Fork** the repo and create a topic branch from `main`:
   `git checkout -b feat/your-thing`
2. **Commit** your changes with a clear message. All commits must be
   signed off — see the DCO section below.
3. **Push** to your fork and open a PR against `agentc7/ac7:main`.
4. CI runs `lint`, `typecheck`, `test`, and the DCO check on every PR.
   All four must pass.
5. A maintainer will review. Expect some back-and-forth — that's
   normal.
6. Once approved, a maintainer squashes and merges. The `Signed-off-by`
   trailers are preserved.

## DCO — Developer Certificate of Origin

AgentC7 uses the [DCO](https://developercertificate.org) to track the
provenance of every contribution. The DCO is a lightweight,
once-and-done attestation that you have the right to submit the code
you're sending us. There is **no CLA, no paperwork, no login flow.**

### What you're asserting

By signing off on a commit, you're agreeing to the text at
<https://developercertificate.org>. In plain language:

- The code is yours (or you have the right to submit it under this
  project's license).
- You're OK with it being public, under Apache 2.0, forever.
- You keep your copyright — you're granting a license, not assigning
  ownership.

### How to sign off

Add a `Signed-off-by:` trailer to every commit. Git makes this a
one-flag operation:

```bash
git commit -s -m "fix: tighten objective state transitions"
```

That adds a line like:

```
Signed-off-by: Your Name <you@example.com>
```

to the end of the commit message. The name and email must match your
`git config user.name` and `user.email`.

To make `-s` automatic on every commit:

```bash
git config --global format.signOff true
```

### Forgot to sign off?

Amend the last commit:

```bash
git commit --amend --signoff --no-edit
git push --force-with-lease
```

For multiple commits in a branch, rebase with `--signoff`:

```bash
git rebase --signoff main
git push --force-with-lease
```

The [DCO check](https://github.com/apps/dco) runs on every PR; it'll
tell you which commits are missing sign-off and how to fix them.

## Commit message conventions

Use clear, imperative-mood subject lines. Conventional Commits-style
prefixes are appreciated but not required:

- `feat: ...` for new functionality
- `fix: ...` for bug fixes
- `docs: ...` for doc-only changes
- `chore: ...` for tooling / infra
- `refactor: ...` for non-behavioral code changes
- `test: ...` for test-only changes

Keep the subject under 72 chars. If the change needs context, put it
in the body (explain **why**, not what — the diff shows what).

## Code style

- **TypeScript**: strict mode, no `any` escapes, no
  `noUnusedLocals`/`noUnusedParameters` exceptions.
- **Formatter / linter**: Biome. `pnpm lint:fix` cleans most issues.
- **Imports**: sorted automatically by Biome's `organizeImports`.
- **Tests**: colocate in `src/**/*.test.ts` or `test/`. Prefer Vitest;
  the server has specific integration test conventions documented in
  `apps/server/test/README.md`.

## What to contribute

- **Bug fixes** with a clear reproduction are always welcome.
- **Docs improvements** — clarifications, typos, examples — merge fast.
- **Features** — please open a discussion or issue first. We care a lot
  about keeping the OSS focused on the Seven Cs primitives; not every
  good idea belongs in the core. "It would be easy to add X" is usually
  not a sufficient reason by itself.
- **Performance work** — include before/after benchmarks.

## License

By contributing, you agree that your contribution is licensed under
Apache License 2.0 (see [LICENSE](LICENSE)). You retain copyright in
your contribution; the DCO sign-off is your grant of the Apache 2.0
license to the project and its downstream users.

Names of contributors are recorded in [AUTHORS](AUTHORS) — feel free
to add yourself in your first PR.
