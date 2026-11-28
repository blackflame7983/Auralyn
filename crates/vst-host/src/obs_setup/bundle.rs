//! 配信状態に含めるOBS値。任意settings・接続資格情報・同期値を保持しない。
use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Property {
    Volume,
    Muted,
    Monitor,
    FilterEnabled { name: String, kind: String },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Item {
    pub source: String,
    pub kind: String,
    pub property: Property,
    pub value: Value,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Saved {
    pub collection: String,
    pub items: Vec<Item>,
}

pub fn validate(saved: &Saved) -> Result<(), String> {
    if saved.collection.is_empty() || saved.items.is_empty() || saved.items.len() > 128 {
        return Err("OBS保存対象が不正です（最大128項目）".into());
    }
    let mut seen = std::collections::HashSet::new();
    for item in &saved.items {
        if item.source.is_empty()
            || item.kind.is_empty()
            || !seen.insert((
                item.source.clone(),
                serde_json::to_string(&item.property).map_err(error)?,
            ))
        {
            return Err("OBS対象が空または重複しています".into());
        }
        match &item.property {
            Property::Volume
                if item
                    .value
                    .as_f64()
                    .is_some_and(|v| v.is_finite() && (0.0..=20.0).contains(&v)) => {}
            Property::Muted | Property::FilterEnabled { .. } if item.value.is_boolean() => {}
            Property::Monitor
                if serde_json::from_value::<MonitorType>(item.value.clone()).is_ok() => {}
            _ => return Err("保存されたOBS値が不正です".into()),
        }
        if let Property::FilterEnabled { name, kind } = &item.property {
            if name.is_empty() || kind.is_empty() {
                return Err("保存されたフィルタ対象が不正です".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_values_reject_arbitrary_settings_sync_credentials_duplicates_and_nonfinite_volume() {
        assert!(
            serde_json::from_value::<Property>(json!({"type":"settings","password":"x"})).is_err()
        );
        assert!(serde_json::from_value::<Property>(json!({"type":"sync"})).is_err());
        let item = Item {
            source: "voice".into(),
            kind: "wasapi_input_capture".into(),
            property: Property::Volume,
            value: json!(1.0),
        };
        assert!(validate(&Saved {
            collection: "c".into(),
            items: vec![item.clone()]
        })
        .is_ok());
        assert!(validate(&Saved {
            collection: "c".into(),
            items: vec![item.clone(), item.clone()]
        })
        .is_err());
        assert!(validate(&Saved {
            collection: "c".into(),
            items: vec![Item {
                value: json!("NaN"),
                ..item
            }]
        })
        .is_err());
    }
}
