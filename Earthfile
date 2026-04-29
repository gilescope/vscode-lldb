VERSION 0.8

# Reproducible CI for the BugStalker VS Code extension.
#
# The extension is a thin TypeScript shim that spawns
# `bugstalker --dap` over stdio. There is no LLDB, no codelldb Rust
# adapter, no CMake — `npm install && npm run build` is enough to
# produce `out/extension.js`.
#
# Targets:
#   +deps              npm ci into a cached layer
#   +typecheck         tsc --noEmit -p extension/tsconfig.json
#   +webpack           production webpack bundle, exports out/extension.js
#   +vsix              produce vscode-bugstalker-<v>.vsix
#   +lint-package-json jq schema sanity
#   +lint-markdown     markdownlint-cli2 over README.md + BUGSTALKER.md
#   +bs-gate           lint + typecheck (cheap, run before pushing)
#   +all               +bs-gate + +webpack + +vsix
ARG --global VL_PLATFORM=linux/amd64
ARG --global NODE_VERSION=20

common:
    FROM --platform=$VL_PLATFORM node:$NODE_VERSION-bookworm
    ENV CI=1
    ENV DEBIAN_FRONTEND=noninteractive
    RUN apt-get update && \
        apt-get install -y --no-install-recommends \
            ca-certificates \
            jq && \
        rm -rf /var/lib/apt/lists/*
    WORKDIR /vl

# Manifests-only layer. Maximises npm-cache reuse: install only
# re-runs when package.json or package-lock.json moves.
package-manifests:
    FROM +common
    COPY package.json package-lock.json ./

deps:
    FROM +package-manifests
    RUN --mount=type=cache,target=/root/.npm \
        npm ci --no-audit --no-fund

# Full source plus the installed deps. Most other targets start here.
source:
    FROM +deps
    COPY --dir extension ./
    COPY webpack.config.js README.md BUGSTALKER.md \
         .markdownlint-cli2.jsonc \
         ./
    COPY images ./images

typecheck:
    FROM +source
    RUN npx tsc --noEmit -p extension/tsconfig.json

webpack:
    FROM +source
    RUN npx webpack --mode production
    SAVE ARTIFACT out/extension.js AS LOCAL build/extension.js
    SAVE ARTIFACT out/extension.js.map AS LOCAL build/extension.js.map

# `vsce package` produces the installable .vsix. Doesn't need any
# native binaries; the BugStalker DAP server is shipped separately
# (`cargo install bugstalker`).
vsix:
    FROM +source
    # Run the production webpack build in this stage so vsce sees
    # `out/extension.js`.
    RUN npx webpack --mode production
    RUN npm install -g @vscode/vsce@2.32.0
    RUN vsce package --no-dependencies --skip-license -o vscode-bugstalker.vsix
    SAVE ARTIFACT vscode-bugstalker.vsix AS LOCAL build/vscode-bugstalker.vsix

lint-package-json:
    FROM +common
    COPY package.json ./
    RUN jq -e . package.json > /dev/null
    RUN jq -e '.contributes.debuggers | map(.type) | index("bugstalker") != null' \
            package.json > /dev/null \
        || { echo "package.json: missing bugstalker debug type"; exit 1; }
    # `lldb` is an optional second type — when present, it must be
    # an alias for `bugstalker` (same adapter factory, same config
    # provider) so existing CodeLLDB launch.json configs and the
    # ones rust-analyzer auto-generates route to BugStalker without
    # forcing users to rewrite their workflow. We don't enforce
    # the alias from package.json — registration happens in
    # extension/main.ts — but we do reject a third type sneaking in.
    RUN jq -e '.contributes.debuggers | length <= 2 \
                and (map(.type) | all(. == "bugstalker" or . == "lldb"))' \
            package.json > /dev/null \
        || { echo "package.json: only `bugstalker` and (optionally) `lldb` debug types are allowed"; exit 1; }
    RUN jq -e '.contributes.debuggers[]
                | select(.type == "bugstalker")
                | .configurationAttributes.launch.properties.cargo != null' \
            package.json > /dev/null \
        || { echo "package.json: bugstalker launch missing cargo property"; exit 1; }
    RUN jq -e '.contributes.configuration.properties["bugstalker.executable"] != null' \
            package.json > /dev/null \
        || { echo "package.json: missing bugstalker.executable setting"; exit 1; }
    RUN jq -e '.contributes.configuration.properties["bugstalker.logFile"] != null' \
            package.json > /dev/null \
        || { echo "package.json: missing bugstalker.logFile setting"; exit 1; }

lint-markdown:
    FROM +common
    RUN npm install -g markdownlint-cli2@0.15.0
    COPY .markdownlint-cli2.jsonc README.md BUGSTALKER.md ./
    RUN markdownlint-cli2 README.md BUGSTALKER.md

bs-gate:
    BUILD +lint-package-json
    BUILD +lint-markdown
    BUILD +typecheck

# Detached GPG signature over the .vsix output.
#
# Runs on the host (LOCALLY) — Earthly's container builds can't
# reach the GPG agent socket or talk to a yubikey pinentry, so
# signing has to happen outside the sandbox.
#
# Key selection, in priority order:
#   1. earthly --GPG_KEY=<long-id> +sign-vsix
#   2. git config user.signingkey (the typical case — matches the
#      key already used to sign commits)
#   3. GPG's default identity
#
# Produces build/vscode-bugstalker.vsix.asc alongside the .vsix.
# The detached signature is round-tripped through `gpg --verify`
# before the target exits so a bad signing pipeline fails loudly
# instead of silently producing a corrupt .asc.
#
# Heads-up: with a yubikey this will prompt for a touch.
sign-vsix:
    LOCALLY
    ARG GPG_KEY=
    BUILD +vsix
    RUN set -e; \
        key="${GPG_KEY:-$(git config --get user.signingkey 2>/dev/null || true)}"; \
        if [ -n "$key" ]; then \
            gpg --detach-sign --armor --yes \
                --local-user "$key" \
                --output build/vscode-bugstalker.vsix.asc \
                build/vscode-bugstalker.vsix; \
        else \
            gpg --detach-sign --armor --yes \
                --output build/vscode-bugstalker.vsix.asc \
                build/vscode-bugstalker.vsix; \
        fi; \
        gpg --verify build/vscode-bugstalker.vsix.asc build/vscode-bugstalker.vsix; \
        echo "[+sign-vsix] signed → build/vscode-bugstalker.vsix.asc"

all:
    BUILD +bs-gate
    BUILD +webpack
    BUILD +vsix

# Release target: gate + unsigned .vsix + detached GPG signature.
# Use this when cutting a build to publish; +all stays touch-free
# for day-to-day work.
release:
    BUILD +all
    BUILD +sign-vsix
