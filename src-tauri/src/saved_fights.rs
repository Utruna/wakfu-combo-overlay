//! Fights kept with the recap's "Sauvegarder" button. The recap forgets its
//! fights when the app quits; these are written to saved_fights.json (next to
//! settings.json) and come back in the recap's list at every launch. Each is
//! kept as the recap showed it when saved (see FightRecorder::to_json).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use crate::log_reader::now_ms;

pub struct SavedFights {
    path: PathBuf,
    /// Oldest first, each with its "savedId" and "savedAt".
    fights: Vec<Value>,
    next_id: u64,
    /// This session's fights already saved: recap id -> saved id.
    session: HashMap<u64, u64>,
}

fn saved_id(fight: &Value) -> Option<u64> {
    fight.get("savedId").and_then(Value::as_u64)
}

impl SavedFights {
    pub fn open(path: PathBuf) -> Self {
        let fights: Vec<Value> = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|file| file.get("fights").and_then(Value::as_array).cloned())
            .unwrap_or_default()
            .into_iter()
            .filter(|fight| saved_id(fight).is_some())
            .collect();
        let next_id = fights.iter().filter_map(saved_id).max().unwrap_or(0) + 1;
        Self { path, fights, next_id, session: HashMap::new() }
    }

    /// Keeps a finished fight of the session (`fight`: its recap record).
    pub fn save(&mut self, fight: &Value) -> Result<(), String> {
        let id = fight.get("id").and_then(Value::as_u64).ok_or("Combat inconnu.")?;
        if fight.get("live") == Some(&Value::Bool(true)) {
            return Err("Le combat n'est pas terminé.".into());
        }
        if self.session.contains_key(&id) {
            return Ok(());
        }
        let mut kept = fight.clone();
        kept["savedId"] = json!(self.next_id);
        kept["savedAt"] = json!(now_ms());
        kept["isNew"] = json!(false);
        self.fights.push(kept);
        self.session.insert(id, self.next_id);
        self.next_id += 1;
        self.persist()
    }

    /// Forgets a saved fight (from disk too).
    pub fn delete(&mut self, saved: u64) -> bool {
        let before = self.fights.len();
        self.fights.retain(|fight| saved_id(fight) != Some(saved));
        self.session.retain(|_, s| *s != saved);
        let deleted = self.fights.len() != before;
        if deleted {
            let _ = self.persist();
        }
        deleted
    }

    /// The saved copy of a session fight, if it has one.
    pub fn saved_id_of(&self, session_id: u64) -> Option<u64> {
        self.session.get(&session_id).copied()
    }

    /// Adds the saved fights to the recap's: session fights say they're saved,
    /// those of earlier sessions follow them, newest first.
    pub fn merge_into(&self, recap: &mut Value) {
        let Some(fights) = recap.get_mut("fights").and_then(Value::as_array_mut) else { return };
        // Saved fights the session still shows (it drops its oldest ones).
        let mut in_session = Vec::new();
        for fight in fights.iter_mut() {
            let saved = fight.get("id").and_then(Value::as_u64).and_then(|id| self.saved_id_of(id));
            fight["saved"] = json!(saved.is_some());
            fight["savedId"] = json!(saved);
            in_session.extend(saved);
        }
        for kept in self.fights.iter().rev() {
            let Some(saved) = saved_id(kept) else { continue };
            if in_session.contains(&saved) {
                continue;
            }
            let mut fight = kept.clone();
            // Apart from the session's own ids.
            fight["id"] = json!(format!("saved-{saved}"));
            fight["saved"] = json!(true);
            fight["live"] = json!(false);
            fight["isNew"] = json!(false);
            fights.push(fight);
        }
    }

    /// Write-then-rename, like settings.json: never a half-written file.
    fn persist(&self) -> Result<(), String> {
        let result = (|| -> std::io::Result<()> {
            if let Some(dir) = self.path.parent() {
                fs::create_dir_all(dir)?;
            }
            let tmp = self.path.with_extension("json.tmp");
            fs::write(&tmp, serde_json::to_string(&json!({ "fights": self.fights })).map_err(std::io::Error::other)?)?;
            fs::rename(&tmp, &self.path)
        })();
        result.map_err(|err| {
            eprintln!("[SavedFights] Failed to write {}: {err}", self.path.display());
            "Impossible d'enregistrer le combat sur le disque.".to_string()
        })
    }
}
