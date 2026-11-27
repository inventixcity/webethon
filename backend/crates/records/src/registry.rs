use std::{collections::BTreeMap, path::Path};

use anyhow::{Context, ensure};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityDefinition {
    pub label: String,
    pub read: ReadAccess,
    pub create: CreateAccess,
    pub write: WriteAccess,
    pub allow_public: bool,
    pub max_per_owner: u64,
    pub sortable: Vec<String>,
    pub filterable: Vec<String>,
    pub searchable: Vec<String>,
    pub schema: Value,
    #[serde(default)]
    pub social: Option<SocialConfig>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct SocialConfig {
    pub comments: bool,
    pub reactions: Vec<String>,
    pub bookmarks: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReadAccess {
    Owner,
    Authenticated,
    Public,
    Admin,
}
#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CreateAccess {
    Authenticated,
    Admin,
}
#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WriteAccess {
    Owner,
    Admin,
}

pub(crate) struct Entity {
    pub(crate) definition: EntityDefinition,
    #[allow(dead_code)]
    pub(crate) validator: jsonschema::Validator,
}

/// Entity definitions and their precompiled validators, loaded at startup.
#[derive(Clone)]
pub struct EntityRegistry {
    pub(crate) entities: std::sync::Arc<BTreeMap<String, Entity>>,
}

impl EntityRegistry {
    pub fn from_json(input: &str) -> anyhow::Result<Self> {
        parse_registry(input)
    }

    pub fn definition(&self, name: &str) -> kernel::AppResult<&EntityDefinition> {
        self.entities
            .get(name)
            .map(|e| &e.definition)
            .ok_or_else(kernel::AppError::not_found)
    }
    /// Returns entity names and definitions in ascending name order.
    pub fn definitions(&self) -> impl Iterator<Item = (&str, &EntityDefinition)> {
        self.entities
            .iter()
            .map(|(name, entity)| (name.as_str(), &entity.definition))
    }
}

fn require_nonempty_strings(schema: &mut Value) {
    if let Some(object) = schema.as_object_mut() {
        let required: Vec<String> = object
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        if let Some(properties) = object.get_mut("properties").and_then(Value::as_object_mut) {
            for (name, property) in properties {
                if required.contains(name)
                    && types(property).contains(&"string")
                    && let Some(property) = property.as_object_mut()
                {
                    property.entry("minLength").or_insert(Value::from(1));
                }
                require_nonempty_strings(property);
            }
        }
        if let Some(items) = object.get_mut("items") {
            require_nonempty_strings(items);
        }
    }
}

fn types(schema: &Value) -> Vec<&str> {
    match &schema["type"] {
        Value::String(s) => vec![s.as_str()],
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

// Require explicit bounds recursively: the database size limit is a last line of defence,
// not a substitute for limits in the published schema.
fn validate_schema(schema: &Value, location: &str) -> anyhow::Result<()> {
    let object = schema.as_object().context("schema must be an object")?;
    ensure!(
        !object.contains_key("$ref") && !object.contains_key("$dynamicRef"),
        "{location}: references are not supported"
    );
    let kinds = types(schema);
    ensure!(
        !kinds.is_empty(),
        "{location}: an explicit type is required"
    );
    ensure!(
        kinds.iter().all(|t| matches!(
            *t,
            "object" | "array" | "string" | "integer" | "number" | "boolean" | "null"
        )),
        "{location}: invalid type"
    );
    if kinds.contains(&"string") {
        ensure!(
            schema["maxLength"].as_u64().is_some(),
            "{location}: strings need maxLength"
        );
    }
    if kinds.contains(&"array") {
        ensure!(
            schema["maxItems"].as_u64().is_some(),
            "{location}: arrays need maxItems"
        );
        let items = object.get("items").context("array items must be defined")?;
        validate_schema(items, &format!("{location}.items"))?;
    }
    if kinds.contains(&"object") {
        ensure!(
            schema["additionalProperties"] == false,
            "{location}: additionalProperties must be false"
        );
        let props = schema["properties"]
            .as_object()
            .context("object properties must be defined")?;
        for (name, property) in props {
            validate_schema(property, &format!("{location}.{name}"))?;
        }
    }
    // Unchecked subschemas can otherwise introduce unbounded strings, arrays, or objects.
    for keyword in [
        "allOf",
        "anyOf",
        "oneOf",
        "not",
        "if",
        "then",
        "else",
        "patternProperties",
        "dependentSchemas",
        "prefixItems",
        "contains",
        "unevaluatedProperties",
        "unevaluatedItems",
    ] {
        ensure!(
            !object.contains_key(keyword),
            "{location}: {keyword} is not supported"
        );
    }
    Ok(())
}

pub(crate) fn parse_registry(input: &str) -> anyhow::Result<EntityRegistry> {
    let definitions: BTreeMap<String, EntityDefinition> =
        serde_json::from_str(input).context("invalid entity configuration")?;
    let mut entities = BTreeMap::new();
    for (name, mut definition) in definitions {
        let mut chars = name.bytes();
        ensure!(
            name.len() <= 48
                && chars.next().is_some_and(|c| c.is_ascii_lowercase())
                && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_'),
            "invalid entity name: {name}"
        );
        ensure!(
            !definition.label.trim().is_empty() && definition.label.len() <= 120,
            "{name}: invalid label"
        );
        ensure!(
            definition.max_per_owner > 0 && definition.max_per_owner <= i64::MAX as u64,
            "{name}: invalid maxPerOwner"
        );
        ensure!(
            definition.schema["type"] == "object",
            "{name}: root schema must be an object"
        );
        if let Some(social) = &definition.social {
            ensure!(
                social.reactions.len() <= 16,
                "{name}: too many reaction kinds"
            );
            let mut seen = std::collections::HashSet::new();
            for kind in &social.reactions {
                ensure!(
                    !kind.is_empty()
                        && kind.len() <= 32
                        && kind.bytes().all(|c| c.is_ascii_lowercase()
                            || c.is_ascii_digit()
                            || c == b'_'
                            || c == b'-')
                        && seen.insert(kind),
                    "{name}: invalid reaction kind"
                );
            }
        }
        validate_schema(&definition.schema, &name)?;
        require_nonempty_strings(&mut definition.schema);
        let props = definition.schema["properties"]
            .as_object()
            .context("missing properties")?;
        for (fields, searchable) in [
            (&definition.sortable, false),
            (&definition.filterable, false),
            (&definition.searchable, true),
        ] {
            let mut seen = std::collections::HashSet::new();
            for field in fields {
                ensure!(seen.insert(field), "{name}: duplicate field {field}");
                let prop = props
                    .get(field)
                    .with_context(|| format!("{name}: unknown field {field}"))?;
                let ts = types(prop);
                ensure!(
                    ts.iter().all(|t| *t == "null"
                        || if searchable {
                            *t == "string"
                        } else {
                            matches!(*t, "string" | "number" | "integer" | "boolean")
                        }),
                    "{name}: unsupported field {field}"
                );
            }
        }
        let validator = jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .should_validate_formats(true)
            .build(&definition.schema)
            .map_err(|e| anyhow::anyhow!("{name}: invalid schema: {e}"))?;
        entities.insert(
            name,
            Entity {
                definition,
                validator,
            },
        );
    }
    Ok(EntityRegistry {
        entities: std::sync::Arc::new(entities),
    })
}

/// Loads and validates all entity definitions. Invalid configuration prevents startup.
pub fn load_registry(path: impl AsRef<Path>) -> anyhow::Result<EntityRegistry> {
    let path = path.as_ref();
    let input = std::fs::read_to_string(path)
        .with_context(|| format!("could not read {}", path.display()))?;
    parse_registry(&input)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;
    fn config() -> Value {
        json!({"notes":{"label":"Note","read":"owner","create":"authenticated","write":"owner","allowPublic":true,"maxPerOwner":20,"sortable":["title"],"filterable":[],"searchable":["title"],"schema":{"type":"object","additionalProperties":false,"properties":{"title":{"type":"string","maxLength":10}}}}})
    }
    #[test]
    fn required_string_bounds_are_recursive_and_preserve_explicit_limits() {
        let mut base = config();
        base["notes"]["schema"]["required"] = json!(["title", "nested"]);
        base["notes"]["schema"]["properties"]["nested"] = json!({"type":"object", "additionalProperties":false, "required":["value", "allowed"], "properties":{"value":{"type":"string", "maxLength":10}, "allowed":{"type":"string", "minLength":0, "maxLength":10}}});
        let registry = parse_registry(&base.to_string()).unwrap();
        let schema = &registry.definition("notes").unwrap().schema;
        assert_eq!(schema["properties"]["title"]["minLength"], 1);
        assert_eq!(
            schema["properties"]["nested"]["properties"]["value"]["minLength"],
            1
        );
        assert_eq!(
            schema["properties"]["nested"]["properties"]["allowed"]["minLength"],
            0
        );
    }
    #[test]
    fn config_validation() {
        let base = config();
        assert!(parse_registry(&base.to_string()).is_ok());
        let mut bad = base.clone();
        bad["Bad"] = bad["notes"].clone();
        assert!(parse_registry(&bad.to_string()).is_err());
        let mut bad = base.clone();
        bad["notes"]["schema"]["additionalProperties"] = json!(true);
        assert!(parse_registry(&bad.to_string()).is_err());
        let mut bad = base.clone();
        bad["notes"]["schema"]["properties"]["title"]
            .as_object_mut()
            .unwrap()
            .remove("maxLength");
        assert!(parse_registry(&bad.to_string()).is_err());
        let mut bad = base.clone();
        bad["notes"]["schema"]["properties"]["title"] =
            json!({"type":"array","items":{"type":"boolean"}});
        assert!(parse_registry(&bad.to_string()).is_err());
        let mut bad = base.clone();
        bad["notes"]["sortable"] = json!(["missing"]);
        assert!(parse_registry(&bad.to_string()).is_err());
        let mut bad = base.clone();
        bad["notes"]["schema"]["properties"]["title"] = json!({"type":"boolean"});
        assert!(parse_registry(&bad.to_string()).is_err());
    }
}
