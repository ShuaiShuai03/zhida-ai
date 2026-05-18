# Spec: Proxy Security Hardening and Runtime Matrix

## Assumptions

1. This repository remains a no-build static frontend plus a same-origin Node proxy.
2. The project now accepts Node.js 20+ as the minimum supported local runtime; Docker proxy may continue to use Node 22.
3. The browser must never be able to read backend source, encrypted config files, scripts, CI metadata, local analysis files, or repository metadata through the Node proxy static server.
4. Proxy Docker images must not contain local encrypted config files or ad-hoc local analysis artifacts from the build context.
5. No new third-party dependencies are needed.

## Objective

Fix the security and deployment findings from the code review:

- Restrict the Node proxy static server to known frontend assets only.
- Keep encrypted API configuration outside any browser-served path.
- Prevent Docker proxy images from embedding local ignored secrets or analysis files.
- Run the proxy container as a non-root user.
- Align README, scripts, and CI with a Node.js 20+ support matrix.
- Add CI coverage for the proxy Docker image, not only the static Nginx image.

Success means a normal user can still open the app, configure the same-origin proxy, fetch models, chat, and run smoke tests, while requests such as `/server/server.js` and `/server/data/config.enc.json` return 404.

## Tech Stack

- Frontend: HTML, CSS, ES modules, no bundler.
- Backend proxy: Node.js 20+ with built-in `http`, `fetch`, and `crypto`.
- Docker proxy image: Node Alpine, defaulting to Node 22 and CI-tested with Node 20 and Node 22.
- Tests: Node built-in test runner, shell/Python syntax checks, browser smoke, Docker build/run smoke.

## Commands

- Markdown: `python3 scripts/check_markdown.py`
- JavaScript syntax: `for f in js/*.js; do node --check "$f"; done && node --check server/server.js`
- Unit/integration tests: `node --test tests/*.test.mjs`
- Shell/Python syntax: `bash -n scripts/start.sh scripts/run_smoke.sh && python3 -m py_compile scripts/check_markdown.py scripts/mock_api.py`
- Browser smoke: `bash scripts/run_smoke.sh`
- Static Docker: `docker build -t zhida-ai-test .`
- Proxy Docker: `docker build -f Dockerfile.server --build-arg NODE_VERSION=22 -t zhida-ai-proxy-test .`
- Whitespace: `git diff --check`

## Project Structure

- `index.html`, `css/`, `js/`, `assets/` are browser-served app assets.
- `server/server.js` contains the same-origin proxy and static file handler.
- `server/data/` is local runtime state and must never be served or copied into Docker image layers.
- `scripts/` contains local validation and startup scripts, not browser app assets.
- `tests/` contains Node and browser smoke tests.
- `.github/workflows/ci.yml` contains CI validation.
- `specs/` contains implementation specs for multi-file changes.

## Code Style

Prefer explicit allowlists for security-sensitive routing:

```js
function isAllowedStaticPath(pathname) {
  return pathname === '/index.html'
    || pathname.startsWith('/css/')
    || pathname.startsWith('/js/')
    || pathname.startsWith('/assets/')
    || pathname === '/tests/smoke.html';
}
```

Keep errors user-facing and Chinese where they are returned to the app. Keep test names behavior-oriented and DAMP.

## Testing Strategy

- Add server integration tests that prove internal paths are blocked before relying on manual checks.
- Keep existing proxy authorization and encrypted-config tests green.
- Run browser smoke to catch frontend/backend regressions.
- Run Docker proxy build/run checks so image packaging and runtime paths are covered.

## Boundaries

- Always: keep API keys out of browser storage, backups, frontend request headers, Docker image layers, and tracked files.
- Always: preserve existing user-local ignored files such as `FIXES_SUMMARY.md`, `analysis/`, and `server/data/`.
- Always: use exact path staging if committing later.
- Ask first: adding runtime dependencies, changing public API routes, deleting user-local ignored files.
- Never: commit `.env`, encrypted config files, `.codex`, `.agents`, analysis workbooks, `__pycache__`, or `.pyc` files.

## Success Criteria

- `GET /server/server.js` returns 404.
- `GET /server/data/config.enc.json` returns 404 even when that file exists locally.
- Missing files under allowed static prefixes return 404 instead of falling back to `index.html`.
- `/index.html`, `/css/*`, `/js/*`, `/assets/*`, and `/tests/smoke.html` continue to work.
- Default encrypted config path is outside the browser-served static allowlist.
- Saving config with no explicit `ZHIDA_CONFIG_PATH` writes `.zhida-data/config.enc.json` and does not rewrite the legacy file.
- Legacy `server/data/config.enc.json` deployments do not break abruptly; the backend may read the old file for compatibility while new saves use `.zhida-data/config.enc.json`.
- 显式设置 `ZHIDA_CONFIG_PATH=/data/config.enc.json` 但该文件不存在时，后端可只读回退到 `server/data/config.enc.json`（或 `LEGACY_DOCKER_CONFIG_PATH`）并继续服务。
- `Dockerfile.server` image does not contain `/app/server/data/config.enc.json`.
- CI creates sentinel local-only files and verifies `.dockerignore` keeps them out of Docker images.
- Proxy Docker container runs as a non-root user.
- CI pins the browser smoke runtime to a supported Node.js version.
- Compose deployments do not force a global container name, so different project names can run without container-name collisions.
- CI validates Compose legacy config migration by mounting an old `/app/server/data/config.enc.json`, reading it, and then saving to `/data/config.enc.json`.
- README, scripts, and CI consistently state Node.js 20+.
- CI validates both the static image and the proxy image path.
- CI validates proxy Docker smoke and Compose fresh-volume writes on both Node 20 and Node 22.
- Full repository validation commands pass.

## Open Questions

None. The user explicitly accepted Node.js 20+/22+ as the supported runtime direction.

## Implementation Plan

1. Add regression tests for blocked internal static paths and allowed app paths.
2. Restrict `server/server.js` static serving to explicit frontend allowlist and move default config path outside the served tree.
3. Harden Docker context/image and proxy runtime path.
4. Update README, startup scripts, and CI runtime matrix to Node.js 20+ and proxy Docker smoke.
5. Run full validation and independent review.

## Tasks

- [x] Task: Add server regression tests for static allowlist
  - Acceptance: internal paths return 404; frontend assets still return 200.
  - Verify: `node --test tests/server.test.mjs`
  - Files: `tests/server.test.mjs`
- [x] Task: Implement backend static allowlist and config-path isolation
  - Acceptance: tests pass and local curl cannot read `/server/*`.
  - Verify: `node --test tests/server.test.mjs`
  - Files: `server/server.js`
- [x] Task: Harden Docker proxy and runtime docs
  - Acceptance: proxy image excludes local config and runs non-root.
  - Verify: `docker build -f Dockerfile.server -t zhida-ai-proxy-test .`
  - Files: `.dockerignore`, `Dockerfile.server`, `docker-compose.proxy.yml`, README/scripts as needed
- [x] Task: Update CI and runtime matrix
  - Acceptance: CI validates Node 20+ and proxy Docker smoke.
  - Verify: inspect `.github/workflows/ci.yml` plus local syntax checks.
  - Files: `.github/workflows/ci.yml`, `README.md`, `scripts/start.sh`, `scripts/start.ps1`
- [x] Task: Full verification and review
  - Acceptance: all commands pass and independent reviewer finds no blocking issues.
  - Verify: full command list above.
  - Files: no additional expected changes
