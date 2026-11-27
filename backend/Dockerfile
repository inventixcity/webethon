# syntax=docker/dockerfile:1

# Multi-stage build for the `api` binary (crate `server`).
#
#   chef     -> rust toolchain + cargo-chef
#   planner  -> records the dependency graph in recipe.json (changes only when manifests change)
#   builder  -> compiles dependencies from the recipe (cached layer), then the real source
#   runtime  -> distroless, non-root, no shell, no package manager
#
# Build from the backend directory:  docker build -t invigil-api:dev backend

ARG RUST_IMAGE=rust:1-bookworm
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian12:nonroot
ARG CARGO_CHEF_VERSION=0.1.78

FROM ${RUST_IMAGE} AS chef
ARG CARGO_CHEF_VERSION
# Built from source once per cache; the registry cache mount keeps repeat builds fast.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    cargo install cargo-chef --version "${CARGO_CHEF_VERSION}" --locked
WORKDIR /build

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
# Cargo.lock is committed for this binary crate. The wildcard copies it when present; the
# recipe.json source always matches, so the COPY never fails for a missing lock file.
COPY --from=planner /build/recipe.json /build/Cargo.lock* ./
# Compiles every dependency. This layer is reused until Cargo.toml or Cargo.lock changes.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    if [ -f Cargo.lock ]; then \
      cargo chef cook --release --recipe-path recipe.json --locked; \
    else \
      cargo chef cook --release --recipe-path recipe.json; \
    fi
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    if [ -f Cargo.lock ]; then \
      cargo build --release --bin api --locked; \
    else \
      cargo build --release --bin api; \
    fi

FROM ${RUNTIME_IMAGE} AS runtime
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=1970-01-01T00:00:00Z

WORKDIR /app
# Root-owned and read-only for the app user. The process never writes to disk.
COPY --from=builder /build/target/release/api /app/api
COPY migrations /app/migrations
COPY config /app/config

# Secure default: an image run without env uses production rules and refuses to start
# unless the secrets are set. Compose and Kubernetes set APP_ENV explicitly.
ENV APP_ENV=production \
    BIND_ADDR=0.0.0.0:8080 \
    METRICS_ADDR=0.0.0.0:9090 \
    ENTITIES_PATH=/app/config/entities.json

EXPOSE 8080 9090

# Numeric form of the distroless `nonroot` user (uid 65532), so Kubernetes can verify runAsNonRoot.
USER 65532:65532

# `api healthcheck` probes the local liveness endpoint; exec form needs no shell in distroless.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/app/api", "healthcheck"]

ENTRYPOINT ["/app/api"]
CMD ["serve"]

LABEL org.opencontainers.image.title="invigil-api" \
      org.opencontainers.image.description="Auth and config-driven data API for the invigil kit" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"
