# Releasing Planboard

Planboard ships to npm as `planboard`. The release flow follows draftably and explorEDA:

1. A PR that changes what the package ships adds a changeset.
2. The PR merges into `main`.
3. The Release workflow opens or updates the **Version Packages** PR. That PR bumps `version` in `package.json` and writes `CHANGELOG.md`.
4. Byron reviews the version and the changelog, and merges that PR.
5. The Release workflow checks the package contents, publishes the new version to npm, and creates the tag and the GitHub release.

The Release workflow (`.github/workflows/release.yml`) runs only when `.changeset/` changes on `main`, or through **Run workflow**. Ordinary commits do not start a release. The repository has no dependencies, so the scripts run a pinned `@changesets/cli` through `npx`.

## Add a release note

```sh
npm run changeset:add patch "Describe the change for Planboard users."
npm run changeset:status
```

Use `minor` for a feature and `major` for a breaking change. Commit the new `.changeset/*.md` file with the change. One changeset per PR is usual; edit it when the PR's scope changes.

The Check workflow runs `npm run changeset:check` on each PR. It fails when the PR changes a shipped file (the paths in `files` in `package.json`) and adds no changeset. For a change that needs no release, add an empty changeset with `npx @changesets/cli@2.31.1 add --empty`.

Do not run `npm run release` or `npm run changeset:version` during normal work. Do not edit `version` or `CHANGELOG.md` by hand. The Version Packages PR does that.

## Set up npm (once)

npm publishes from the workflow through trusted publishing (OIDC). The workflow holds no npm token. npm can trust a workflow only for a package that already exists, so publish the first version by hand:

```sh
npm login
npm whoami
npm publish --access public
```

Run `npm publish` from a clean checkout of the version to release, after `npm pack --dry-run` shows the expected files. npm asks for a one-time password when the account has 2FA.

Then, on npmjs.com, open the `planboard` package, go to **Settings**, and add a trusted publisher:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `byronwall` |
| Repository | `planboard` |
| Workflow filename | `release.yml` |
| Environment | Leave empty |

In the GitHub repository settings, under **Actions → General**, allow GitHub Actions to create and approve pull requests. The Version Packages PR needs this.

Trusted publishing needs npm 11.5.1 or later; the workflow uses Node 24, which includes it. The workflow also requests npm provenance. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
