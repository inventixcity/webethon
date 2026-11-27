#!/usr/bin/env bash
# Runs cargo inside the official Rust image, so no local toolchain is needed (Windows has no MSVC here).
# Caches the registry and build output in named Docker volumes; joins the compose network for DB tests.
# Usage: scripts/cargo.sh check --workspace   |   scripts/cargo.sh test -p kernel
set -euo pipefail
# The image is rust:1-bookworm plus clippy and rustfmt (scripts/dev-image/Dockerfile), built on first use.
docker image inspect invigil-rust:dev >/dev/null 2>&1 \
  || docker build -q -t invigil-rust:dev "$(dirname "${BASH_SOURCE[0]}")/dev-image" >/dev/null
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -W 2>/dev/null || pwd)"
network_args=()
if docker network inspect invigil_default >/dev/null 2>&1; then network_args=(--network invigil_default); fi
command=(cargo "$@")
if [[ "${1:-}" == test ]]; then
  # SQLx derives test database names from test paths, so concurrent cargo test
  # processes can collide after Cargo releases its build lock. Share this lock
  # across containers for the entire test command to prevent that collision.
  command=(flock -x /work/target/.cargo-test.lock cargo "$@")
fi
exec env MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$here:/work" \
  -v inv-cargo-registry:/usr/local/cargo/registry \
  -v inv-cargo-git:/usr/local/cargo/git \
  -v inv-target:/work/target \
  -e CARGO_TERM_COLOR=never \
  -e DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@postgres:5432/invigil}" \
  -e SQLX_OFFLINE="${SQLX_OFFLINE:-false}" \
  -e CARGO_PROFILE_DEV_DEBUG=0 \
  -e CARGO_PROFILE_TEST_DEBUG=0 \
  -e CARGO_INCREMENTAL=0 \
  "${network_args[@]}" \
  -w /work invigil-rust:dev "${command[@]}"
