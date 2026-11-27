//! Teams: shared workspaces where each person holds a role (owner, admin, member or viewer).
//!
//! Other crates decide access to team-owned data with `require_role`, which answers 404 for
//! non-members and 403 for members who lack the role. See docs/TEAMS.md.

mod access;
mod input;
mod mail;
mod page;
mod role;
mod routes;
mod service;

pub use access::{require_role, require_role_tx, role_of};
pub use role::TeamRole;
pub use routes::router;

#[cfg(test)]
mod tests;
