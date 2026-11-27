use serde_json::Value;

pub fn apply(schema: &Value, value: &mut Value) {
    if let (Some(properties), Some(object)) = (
        schema.get("properties").and_then(Value::as_object),
        value.as_object_mut(),
    ) {
        for (name, property) in properties {
            if !object.contains_key(name)
                && let Some(default) = property.get("default")
            {
                object.insert(name.clone(), default.clone());
            }
            if let Some(child) = object.get_mut(name) {
                apply(property, child);
            }
        }
    }
    if let (Some(items), Some(array)) = (schema.get("items"), value.as_array_mut()) {
        for child in array {
            apply(items, child);
        }
    }
}

/// Normalize all supplied and defaulted text before it is validated and stored.
pub fn trim(value: &mut Value) {
    match value {
        Value::String(text) => *text = text.trim().to_owned(),
        Value::Array(items) => items.iter_mut().for_each(trim),
        Value::Object(fields) => fields.values_mut().for_each(trim),
        _ => {}
    }
}
