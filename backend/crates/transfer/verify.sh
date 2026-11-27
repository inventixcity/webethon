set -eu
mkdir -p /tmp/transfer/src
cp /work/crates/transfer/src/lib.rs /tmp/transfer/src/lib.rs
cat > /tmp/transfer/Cargo.toml <<'EOF'
[package]
name = "transfer-check"
version = "0.1.0"
edition = "2024"
[dependencies]
csv = "1.4.0"
serde_json = "1"
EOF
cd /tmp/transfer
cargo test
cargo clippy --all-targets -- -D warnings
