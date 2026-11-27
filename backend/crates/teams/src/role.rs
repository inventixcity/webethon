//! Roles on a team, ordered from least to most access. Because of the derived `Ord`, `a >= b` reads
//! as "a has at least b's access", which is how every permission check is written.

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TeamRole {
    Viewer,
    Member,
    Admin,
    Owner,
}

impl TeamRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Member => "member",
            Self::Viewer => "viewer",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "owner" => Some(Self::Owner),
            "admin" => Some(Self::Admin),
            "member" => Some(Self::Member),
            "viewer" => Some(Self::Viewer),
            _ => None,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn roles_order_from_least_to_most_access() {
        assert!(TeamRole::Viewer < TeamRole::Member);
        assert!(TeamRole::Member < TeamRole::Admin);
        assert!(TeamRole::Admin < TeamRole::Owner);
    }

    #[test]
    fn roles_round_trip_and_unknown_strings_are_rejected() {
        for role in [
            TeamRole::Owner,
            TeamRole::Admin,
            TeamRole::Member,
            TeamRole::Viewer,
        ] {
            assert_eq!(TeamRole::parse(role.as_str()), Some(role));
        }
        for junk in ["", "Owner", "superuser", "admin ", "owner\n"] {
            assert_eq!(TeamRole::parse(junk), None, "{junk:?}");
        }
    }
}
