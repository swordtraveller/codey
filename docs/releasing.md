# Windows releases

Codey currently publishes Windows x64 NSIS installers.

## Repository settings

Before the first release, configure GitHub repository rulesets:

1. Protect the `main` branch. Require pull requests and the `Build Windows installer` status check before merge.
2. Add a tag ruleset targeting `v*`.
3. Enable restrictions on creation, update, and deletion of matching tags.
4. Add only designated maintainers/administrators to the ruleset bypass list; regular contributors must not bypass it.

Tag authorization is enforced by GitHub repository settings rather than by a list of usernames in the workflow.

## Validation flow

Every pull request targeting `main` runs the same test, native compilation, and packaging steps used by releases. Tests use four workers to limit contention between subprocess-based tests. Node.js 22.16.0, pnpm 10.12.1, and Rust 1.99.0 are pinned; both JavaScript and Rust builds use their committed lockfiles. The packaged native runner is smoke-tested before upload.

For the first rollout, open a pull request from the feature branch and wait for its Windows build to pass **before merging**. Download the workflow artifact and install it on Windows. Do not use `main` to iterate on pipeline failures. A local build is not a substitute for the pull request run.

A push to `main` repeats the package build. Wait for that run to succeed before creating a release tag. Manual workflow runs only build artifacts; publishing requires a tag push.

## Creating a release

1. Update `package.json` to the intended semantic version and merge the change through a green pull request.
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

The installer is named `Codey-<version>-windows-x64-setup.exe`. Installer builds explicitly disable electron-builder publishing; only the separate release job receives write permission.

Published releases are not overwritten automatically. A failed draft release can be rerun safely; its artifacts are replaced before the draft is published.
