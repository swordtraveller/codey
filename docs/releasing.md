# Windows releases

Codey currently publishes Windows x64 NSIS installers.

## Repository settings

Before the first release, configure GitHub repository rulesets:

1. Protect `main` and active `release-*` branches. Require pull requests and the `Build Windows installer` status check before merge.
2. Add a tag ruleset targeting `v*`.
3. Enable restrictions on creation, update, and deletion of matching tags.
4. Add only designated maintainers/administrators to the ruleset bypass list; regular contributors must not bypass it.

Tag authorization is enforced by GitHub repository settings rather than by a list of usernames in the workflow.

## Validation flow

Pull requests targeting `main` or `release-*` run the same tests, native compilation, and Windows packaging steps used by releases. Tests use four workers to limit contention between subprocess-based tests. Node.js 22.16.0, pnpm 10.12.1, and Rust 1.99.0 are pinned; both JavaScript and Rust builds use their committed lockfiles. The packaged native runner is smoke-tested before upload.

Use the repository's staged branch flow:

1. Merge feature branches into the active `release-*` branch through a green pull request.
2. Download the pull request's temporary workflow artifact and install it on Windows before merging. The artifact is retained for 14 days and is not a public GitHub Release.
3. Merge the tested release branch into `main` through a second green pull request.
4. Wait for the resulting `main` push build to succeed before creating a release tag.

Do not use `main` to iterate on pipeline failures. A local build is not a substitute for the pull request run. Pull requests, manual runs, and pushes to `main` can produce temporary workflow artifacts, but they cannot publish a GitHub Release. Only a pushed `v*` tag can run the write-scoped release job.

## Creating a release

1. Update `package.json` to the intended semantic version and merge the change through the feature-to-release and release-to-main pull request flow.
2. Wait for the resulting `main` workflow run to pass.
3. In a clean checkout, create an annotated tag on that exact `main` commit:

   ```powershell
   git switch main
   git pull --ff-only origin main
   # Verify HEAD is the intended commit whose Windows workflow passed.
   git tag -a v0.6.2 -m "Release v0.6.2"
   git push origin v0.6.2
   ```

The tag version must match `package.json`. The tag workflow verifies that the tagged commit is contained in `origin/main`, rebuilds the Windows installer from source, generates `SHA256SUMS.txt`, and publishes both files in a GitHub Release.

The installer is named `Codey-<version>-windows-x64-setup.exe`. Installer builds explicitly disable electron-builder publishing; only the separate tag-gated release job receives write permission.

Published releases are not overwritten automatically. A failed draft release can be rerun safely; its artifacts are replaced before the draft is published.
