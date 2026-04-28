VERSION 0.8

# Reproducible CI for the BugStalker-aware vscode-lldb fork.
#
# Scope: the bits this fork actually changes — `package.json`'s
# `bugstalker` debug-type registration, the `BUGSTALKER.md` doc.
#
# What this Earthfile deliberately *doesn't* try to do:
#
# - Compile the TypeScript extension. The upstream `tsconfig.json`
#   points `paths` at `../build/node_modules/*`, which the upstream
#   CMakeLists.txt populates at build time. Running `tsc` outside
#   that CMake flow fails with module-resolution errors that aren't
#   caused by this fork.
# - Webpack-bundle the extension. `webpack.config.js` carries
#   unresolved CMake placeholders (`@CMAKE_BINARY_DIR@`).
# - Build the codelldb Rust adapter. Needs LLDB headers, clang, and
#   a full LLDB checkout — out of scope for this fork.
#
# The CI gate this Earthfile *does* run:
#
# - `+lint-package-json` — jq-driven schema sanity. Catches
#   regressions where someone drops the `bugstalker` debug type or a
#   `bugstalker.*` setting from package.json.
# - `+lint-markdown` — markdownlint over `BUGSTALKER.md`. Keeps the
#   user-facing quickstart well-formed.
#
# Run `earthly +bs-gate` for the full BugStalker-relevant gate.
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

# Schema sanity. Fails when this fork's BugStalker plumbing has
# silently regressed.
lint-package-json:
    FROM +common
    COPY package.json ./
    # Must parse.
    RUN jq -e . package.json > /dev/null
    # Must register both `lldb` (upstream) and `bugstalker` (fork).
    RUN jq -e '.contributes.debuggers | map(.type) | index("lldb") != null' \
            package.json > /dev/null \
        || { echo "package.json: missing lldb debug type"; exit 1; }
    RUN jq -e '.contributes.debuggers | map(.type) | index("bugstalker") != null' \
            package.json > /dev/null \
        || { echo "package.json: missing bugstalker debug type"; exit 1; }
    # `bugstalker` schema must require nothing — `program` is
    # optional when `cargo` is set.
    RUN jq -e '.contributes.debuggers[] | select(.type == "bugstalker")
                | .configurationAttributes.launch.required // [] | length == 0' \
            package.json > /dev/null \
        || { echo "package.json: bugstalker launch shouldn'\''t require properties; cargo block fills program"; exit 1; }
    # `bugstalker` launch must accept a `cargo` object.
    RUN jq -e '.contributes.debuggers[] | select(.type == "bugstalker")
                | .configurationAttributes.launch.properties.cargo != null' \
            package.json > /dev/null \
        || { echo "package.json: bugstalker launch missing cargo property"; exit 1; }
    # Both fork-specific settings must exist.
    RUN jq -e '.contributes.configuration.properties["bugstalker.executable"] != null' \
            package.json > /dev/null \
        || { echo "package.json: missing bugstalker.executable setting"; exit 1; }
    RUN jq -e '.contributes.configuration.properties["bugstalker.logFile"] != null' \
            package.json > /dev/null \
        || { echo "package.json: missing bugstalker.logFile setting"; exit 1; }

# Markdown lint over the user-facing doc this fork ships. Config in
# `.markdownlint-cli2.jsonc` (relaxes line-length, matches the
# BugStalker repo's own convention).
lint-markdown:
    FROM +common
    RUN npm install -g markdownlint-cli2@0.15.0
    COPY .markdownlint-cli2.jsonc BUGSTALKER.md ./
    RUN markdownlint-cli2 BUGSTALKER.md

# BugStalker-relevant CI gate. Cheap; run before pushing.
bs-gate:
    BUILD +lint-package-json
    BUILD +lint-markdown

all:
    BUILD +bs-gate
