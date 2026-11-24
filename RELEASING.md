# Releasing

Releases are made by [release-please](https://github.com/googleapis/release-please) in `.github/workflows/release.yml`. Nobody edits the version or `CHANGELOG.md` by hand.

## How the version is decided

release-please reads the Conventional Commit subjects merged to `main` since the last release. PRs are merged with merge commits, so each commit inside a PR counts.

- `fix:` bumps the patch version, `feat:` the minor version.
- `!` after the type (`feat!:`, `refactor!:`) or a `BREAKING CHANGE:` footer bumps the major version.
- `perf:` and `revert:` are listed too and bump the patch version.
- `docs`, `refactor`, `test`, `chore`, `build`, `ci` and `style` are left out of the changelog and release nothing on their own, unless marked breaking. A subject that is not a Conventional Commit is ignored.
- To force a version, put a `Release-As: 2.0.0` footer in a commit's body, for example `git commit --allow-empty -m "chore: release 2.0.0" -m "Release-As: 2.0.0"`.

## What happens after a merge to `main`

1. The `release-please` job opens or updates one release PR, `chore(main): release X.Y.Z`. It changes the version in `package.json`, `package-lock.json` and `.release-please-manifest.json` and adds the section to `CHANGELOG.md`.
2. When you merge that PR, the job tags `vX.Y.Z` and creates the GitHub release with the same notes.
3. The `publish` job then checks out the tag and runs `npm publish` through npm trusted publishing: no npm token is stored anywhere, and npm attaches provenance.

The release PR is opened with the workflow's own token, so GitHub holds its `ci` run until someone with write access clicks "Approve workflows to run" in the PR's merge box.

## One-time setup

1. **npm account.** Sign up at npmjs.com as `zharskiy` (the scope of `@zharskiy/pinata` is that username) and turn on two-factor authentication.
2. **Let Actions open the release PR.** GitHub, Settings, Actions, General, Workflow permissions: tick "Allow GitHub Actions to create and approve pull requests". Leave the default permissions on read.
3. **Merge the branch that adds this file, then the release PR it opens** (`chore(main): release 1.0.0`). The `publish` job fails: the package does not exist on npm yet, so it has no trusted publisher.
4. **Publish that first version by hand**, from a clean clone, with npm 11.5.1 or newer:

   ```bash
   git checkout v1.0.0
   npm ci
   npm login
   npm publish
   ```

5. **Add the trusted publisher.** npmjs.com, `@zharskiy/pinata`, Settings, Trusted publishing, GitHub Actions: user `zharskiy`, repository `pi-extensions`, workflow `release.yml`, no environment, and allow `npm publish`. The fields are case-sensitive. Or, with npm 11.15.0 or newer: `npm trust github @zharskiy/pinata --file release.yml --repo zharskiy/pi-extensions --allow-publish`. Do this shortly before you merge the next release PR: npm drops a trusted publisher that has not published within 2 days.
6. After the next release has published from the workflow, set the package's Publishing access to "Require two-factor authentication and disallow tokens".

## When publishing fails

Open the failed run of `release` and click "Re-run failed jobs" (not "Re-run all jobs": release-please has nothing to do the second time, so `publish` would be skipped). GitHub allows that for 30 days. After that, or when the fix needs a change to the workflow, publish the tag by hand as in step 4.
