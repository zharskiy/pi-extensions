# Releasing

How a release of pinata (`@zharskiy/pinata`) is made. Releases come from `.github/workflows/release.yml`: release-please keeps a release PR open on `main`, and merging it tags `vX.Y.Z`, creates the GitHub release and uploads the package tarball (`zharskiy-pinata-X.Y.Z.tgz`), `install.sh` and `SHA256SUMS` to it. The workflow has two jobs after release-please: `build` (checkout, `npm ci`, pack, checksums, upload to the release, and the tarball handed on as a workflow artifact; no `id-token`) and `publish` (only `id-token: write`, no checkout, no `npm ci`, no cache; it publishes the downloaded tarball). `publish` runs only when the repository variable `NPM_PUBLISH` is `true`, through npm trusted publishing (no npm token is stored anywhere), and skips the publish when that version is already on the registry. Every action is pinned by commit SHA with its version in a trailing comment; to move one, take the SHA of the new tag with `git ls-remote https://github.com/<owner>/<action>.git refs/tags/<tag> refs/tags/<tag>^{}` (the `^{}` line is the commit of an annotated tag).

## Which version is released

release-please derives the next version from the commit types since the last release: before 1.0 (`bump-minor-pre-major`), a `feat:` or a breaking change bumps the minor version and a `fix:` the patch version; from 1.0 on, a breaking change bumps the major. PRs are merged with merge commits, so the Conventional Commit subjects of the PR's commits count. To force a version, add a `Release-As: X.Y.Z` footer to a commit on `main`, for example in an empty commit: `git commit --allow-empty -m "chore: release 1.0.0" -m "Release-As: 1.0.0"`.

## One-time setup

1. **npm account.** Sign up at [npmjs.com](https://www.npmjs.com/signup) with the username `zharskiy`: a user scope is the username, so `@zharskiy/pinata` can only be published by that account. Turn on two-factor authentication (Account, Two-Factor Authentication). Publishing by hand and `npm trust` both need it.
2. **GitHub Actions may open the release PR.** Repository Settings, Actions, General, Workflow permissions: tick "Allow GitHub Actions to create and approve pull requests". Without it release-please cannot open its PR with the workflow's own token.
3. **`RELEASE_PLEASE_TOKEN`, required when branch protection requires CI on the release PR.** A PR opened with the workflow's own token does not start other workflows, so `ci` does not run on the release PR, and a required check never reports. Create a fine-grained personal access token for this repository (Contents, Pull requests and Issues: read and write) and save it as the Actions secret `RELEASE_PLEASE_TOKEN`; the workflow uses it when it exists. Without it, close and reopen the release PR by hand each time to start `ci`. A fine-grained token expires: once it has, the secret still exists, so the workflow does not fall back to its own token and release-please fails. Rotate the token before it expires, or delete the secret to fall back.
4. The repository must stay public: npm attaches provenance only for a public repository and a public package.

## The first release

npm can configure a trusted publisher only for a package that already exists on the registry, so the first version is published by hand from the release tarball.

1. Merge the release PR (`chore: release 0.5.0`, or whatever version release-please proposes). The `release` workflow tags `v0.5.0`, creates the GitHub release and uploads the three assets. Its npm steps are skipped, since `NPM_PUBLISH` is not set yet.
2. Publish exactly that tarball, from any machine with npm:

   ```bash
   version=0.5.0
   dir=$(mktemp -d) && cd "$dir"
   gh release download "v$version" --repo zharskiy/pi-extensions
   shasum -a 256 -c SHA256SUMS
   npm login
   npm publish "zharskiy-pinata-$version.tgz" --access public
   ```

   npm asks for the 2FA code. A scoped package is private by default; `--access public` (also set in `publishConfig`) makes it public. This first version carries no provenance, since it was not published from GitHub Actions.
3. Once `@zharskiy/pinata@0.5.0` is on npm, delete the "Before the first release" note at the top of `INSTALL.md` (and its mention in the README's quick start) in a `docs:` commit.

## Switching on trusted publishing

Do this shortly before you merge the next release PR: a new trusted publisher must complete its first publish within 2 days, or it expires and has to be created again.

1. On npmjs.com: Packages, `@zharskiy/pinata`, Settings, Trusted publishing, GitHub Actions. Fill in exactly (the fields are case-sensitive, and npm does not check them when you save):
   - Organization or user: `zharskiy`
   - Repository: `pi-extensions`
   - Workflow filename: `release.yml`
   - Environment: leave empty
   - Allowed actions: allow `npm publish` (only `npm stage publish` is allowed by default, and the workflow runs `npm publish`)

   The same from the command line, with npm 11.15.0 or newer and 2FA on: `npm trust github @zharskiy/pinata --file release.yml --repo zharskiy/pi-extensions --allow-publish`.
2. Turn the publish step on: `gh variable set NPM_PUBLISH --body true --repo zharskiy/pi-extensions` (or Settings, Secrets and variables, Actions, Variables).
3. After the first release that publishes from the workflow, lock the package down: package Settings, Publishing access, "Require two-factor authentication and disallow tokens". Trusted publishing keeps working.

The workflow upgrades npm on the runner to 11.5.1 or newer (trusted publishing needs it, with Node 22.14 or newer) and has `id-token: write`. Provenance is attached automatically; there is no `--provenance` flag.

## Every later release

1. Merge PRs with Conventional Commit subjects; release-please updates its release PR (`package.json`, `package-lock.json`, `CHANGELOG.md`, `.release-please-manifest.json`, and the `extra-files` of `release-please-config.json`: `bootstrap_version` in `install.sh`, the version to install in the README's quick start, the commands in `INSTALL.md`, the pin in `launcher/README.md` and `PINATA_VERSION` in `launcher/examples/org/company-install.sh`). Those lines carry a marker: `x-release-please-version` at the end of one line, or a block between `<!-- x-release-please-start-version -->` and `<!-- x-release-please-end -->` in Markdown, where the first version on each line is replaced. Mark only lines that show the version to install now, never statements about history ("0.5.0 and later", the compatibility table); `test/changelog.test.ts` checks that every extra file carries a marker.
2. Merge the release PR. The workflow tags the release, uploads the assets and publishes the same tarball to npm.

To turn npm publishing off, delete the variable or set it to anything but `true`; the GitHub release and its assets are made either way.

## When the workflow fails

- **A job failed after the release was created** (the upload, or the publish): open the run and use "Re-run failed jobs", not "Re-run all jobs". Re-running all jobs runs release-please again, which has nothing to do, so `build` and `publish` are skipped.
- **The run is gone or cannot be re-run** (for example the publish failed and was fixed later): start the workflow by hand for the existing tag, `gh workflow run release.yml --repo zharskiy/pi-extensions -f tag=v0.6.0`, or Actions, release, Run workflow. It skips release-please, checks out the tag, builds and uploads the assets again (`--clobber` replaces them with ones packed from the same tag; when that version is already on npm, check with the commands under [Verifying a release](#verifying-a-release) that npm's tarball still matches the release's) and, when `NPM_PUBLISH` is `true`, publishes unless that version is already on the registry.

## Verifying a release

```bash
version=0.6.0
gh run list --repo zharskiy/pi-extensions --workflow release.yml --limit 1
gh release view "v$version" --repo zharskiy/pi-extensions
dir=$(mktemp -d) && cd "$dir"
gh release download "v$version" --repo zharskiy/pi-extensions
shasum -a 256 -c SHA256SUMS
sh install.sh --version
npm view "@zharskiy/pinata@$version" version dist.integrity
printf 'sha512-%s\n' "$(openssl dgst -sha512 -binary "zharskiy-pinata-$version.tgz" | base64)"
```

The last two lines print the same `sha512-…` value when npm has the tarball of the GitHub release. The package page on npmjs.com shows the provenance of a version published by the workflow, and `npm audit signatures` checks it in a project that installed the package.
