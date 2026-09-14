use serde::Serialize;
use serde_json::Value;

/// Provider-advertised model choices, independent of the ACP wire format.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub default_model: String,
    pub models: Vec<ModelChoice>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelChoice {
    pub id: String,
    pub name: String,
    pub efforts: Vec<String>,
}

/// Decode the session's available model/effort combinations.
pub fn from_session(session: &Value) -> Option<ModelCatalog> {
    let available = session.pointer("/models/availableModels")?.as_array()?;
    let mut models: Vec<ModelChoice> = Vec::new();
    for entry in available {
        let Some(raw) = entry
            .get("modelId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let (id, effort) = split_model(raw);
        let index = models
            .iter()
            .position(|model| model.id == id)
            .unwrap_or_else(|| {
                let name = entry.get("name").and_then(Value::as_str).unwrap_or(id);
                let suffix = effort.map(|effort| format!(" ({effort})"));
                let name = suffix
                    .as_deref()
                    .and_then(|suffix| name.strip_suffix(suffix))
                    .unwrap_or(name);
                models.push(ModelChoice {
                    id: id.to_owned(),
                    name: name.to_owned(),
                    efforts: Vec::new(),
                });
                models.len() - 1
            });
        if let Some(effort) = effort {
            if !models[index]
                .efforts
                .iter()
                .any(|existing| existing == effort)
            {
                models[index].efforts.push(effort.to_owned());
            }
        }
    }
    if models.is_empty() {
        return None;
    }
    let current = session
        .pointer("/models/currentModelId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Some(ModelCatalog {
        default_model: split_model(current).0.to_owned(),
        models,
    })
}

fn split_model(model: &str) -> (&str, Option<&str>) {
    match model
        .strip_suffix(']')
        .and_then(|value| value.rsplit_once('['))
    {
        Some((id, effort)) if !id.is_empty() && !effort.is_empty() => (id, Some(effort)),
        _ => (model, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn groups_codex_model_effort_variants_without_losing_supported_levels() {
        let catalog = from_session(&json!({"models": {
            "currentModelId": "future[ultra]",
            "availableModels": [
                {"modelId": "future[low]", "name": "Future (low)"},
                {"modelId": "future[ultra]", "name": "Future (ultra)"},
                {"modelId": "small[low]", "name": "Small (low)"}
            ]
        }}))
        .unwrap();
        assert_eq!(catalog.default_model, "future");
        assert_eq!(
            catalog.models,
            vec![
                ModelChoice {
                    id: "future".into(),
                    name: "Future".into(),
                    efforts: vec!["low".into(), "ultra".into()]
                },
                ModelChoice {
                    id: "small".into(),
                    name: "Small".into(),
                    efforts: vec!["low".into()]
                },
            ]
        );
    }

    #[test]
    fn missing_catalog_is_unknown_rather_than_an_empty_success() {
        assert!(from_session(&json!({"sessionId": "s"})).is_none());
    }
}
