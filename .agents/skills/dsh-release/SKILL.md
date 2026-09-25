---
name: dsh-release
description: Publish a dsh-edge release (npm package, GitHub Release, and the Container image) through the tag-driven release workflow, with preflight checks, failure handling, and post-release verification. Use when asked to release, publish, tag, or recover a dsh-edge version, or when a release workflow run fails.
---

# dsh-edge release

A release is one version published in four places that must agree: the npm package, the `dsh-edge-v<version>` git tag, the GitHub Release, and the Container image `docker.io/pawaca/dsh-edge-computer:<version>`. `AGENTS.md` ("Release procedure") is authoritative; this skill is the operational checklist. Tagging, publishing, and reruns require the user's explicit authorization for that version.

## 1. Preflight (all must pass before tagging)

Run from an up-to-date `main` checkout:

```bash
git checkout main && git pull --ff-only
version="$(node -p "require('./apps/dsh-edge/package.json').version")"
```

- `apps/dsh-edge/package.json` has the intended version; `git tag -l "dsh-edge-v$version"` is empty.
- `docs/releases/$version.md`, `docs/releases/$version.zh.md`, and `docs/releases/$version.i18n.yaml` exist on `main`, and `pnpm run doc-sync` passes.
- The Edge CI run for **this exact commit** succeeded, including `edge / container image`. Bind the check to `HEAD`; the newest run may belong to an older commit while this one is still queued:
  ```bash
  commit="$(git rev-parse HEAD)"
  gh run list --workflow "Edge CI" --commit "$commit" --event push --json databaseId,status,conclusion,headSha
  ```
  Require one run with `headSha` equal to `$commit`, `status` `completed`, and `conclusion` `success`. If none exists yet, wait; never tag on an older green run.
- The npm version is unpublished: `npm view "dsh-edge@$version" version` fails with E404.
- The image tag is unpublished; exactly HTTP 404 is required, and anything else means stop and investigate:
  `curl -s -o /dev/null -w '%{http_code}\n' "https://hub.docker.com/v2/repositories/pawaca/dsh-edge-computer/tags/$version"`.
- Both image secrets exist: `gh secret list --repo pawaca/dsh-edge` shows `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.
  (Their values cannot be read; the `publish-image` login step is the real check, and it fails before anything is published.)

## 2. Tag

```bash
git tag "dsh-edge-v$version" && git push origin "dsh-edge-v$version"
```

The tag push starts `release-edge.yml`: `verify-source` → `publish-image` → `publish` (npm, then GitHub Release). Find the run for this tag's commit, not the most recent run (another release may be newer, and a new run can take a few seconds to appear), then watch it to completion:

```bash
gh run list --workflow "Release dsh-edge" --commit "$commit" --json databaseId,headSha,event,status
gh run watch <databaseId> --exit-status
```

A rerun dispatched through `request-release.yml` runs `release-edge.yml` on the default branch, so its `headSha` is the current `main` commit rather than the tag commit; identify it by `event` `repository_dispatch` and its start time.

npm may take several minutes to show a new version after a successful publish; that is npm's asynchronous processing, not a failure.

## 3. When a job fails

| Failing step | State | Action |
|---|---|---|
| `verify-source` | Nothing published | Fix the tag, notes, or version on `main` through a PR. Never move a pushed tag; if the tag is wrong, ask the user before deleting it. |
| `publish-image` login | Nothing published | The Docker Hub token is expired or revoked. The user creates a new Read & Write token for `pawaca` and runs `gh secret set DOCKERHUB_TOKEN`; then rerun (below). |
| `publish-image` lookup ("Could not determine whether … is already published") | Nothing published | Docker Hub was unreachable or returned an unexpected status. Wait and rerun. |
| `publish-image` build or push | Image may be partially pushed; npm not published | Read the log. A rerun is safe: an existing tag is reused, never rebuilt. |
| `publish` checks (`pnpm run check`, integration, snapshots, pack verification) | The image may already exist; npm is not published | Fix the cause on `main`, then cut a **new version**. The orphaned image tag is harmless because no package references it. |
| `publish` after npm succeeded (GitHub Release step) | npm published | Rerun the same tag; recovery reuses the published npm artifact and image. |

Rerun a tag through the default-branch dispatcher (never re-push the tag):

```bash
gh workflow run request-release.yml -f tag="dsh-edge-v$version"
```

Hard rules:
- Never overwrite, delete, or re-push an image tag or npm version. A bad published image or package is fixed by releasing a new version.
- Never run `docker push` for release tags by hand; only `publish-image` pushes them.

## 4. Verify (report each result to the user)

```bash
npm view "dsh-edge@$version" version dist-tags --json
gh release view "dsh-edge-v$version" --json tagName,isPrerelease,assets
curl -s "https://hub.docker.com/v2/repositories/pawaca/dsh-edge-computer/tags/$version" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s);console.log(t.name,t.digest,t.images?.map(i=>i.architecture))})"
```

Expect the npm version (on `next` when the version contains `-`, otherwise `latest`), a GitHub Release with the tarball asset (marked prerelease for prereleases), and an `amd64` image with a digest. Report the digest in the release summary.
