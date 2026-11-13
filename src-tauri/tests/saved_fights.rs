use serde_json::{json, Value};
use std::fs;

use taktik_lib::saved_fights::SavedFights;

fn ids(recap: &Value) -> Vec<Value> {
    recap["fights"].as_array().unwrap().iter().map(|f| f["id"].clone()).collect()
}

#[test]
fn saved_fights_outlive_the_session() {
    let dir = std::env::temp_dir().join(format!("wakfu-saved-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let path = dir.join("saved_fights.json");
    let session = json!({ "fights": [
        { "id": 2, "live": true, "foes": ["Bouftou"] },
        { "id": 1, "live": false, "isNew": true, "foes": ["Ogrest"] },
    ] });

    let mut saved = SavedFights::open(path.clone());
    assert!(saved.save(&session["fights"][0]).is_err(), "a fight in progress isn't saved");
    saved.save(&session["fights"][1]).unwrap();
    saved.save(&session["fights"][1]).unwrap(); // twice: kept once

    // This session: the fight says it's saved, and isn't listed twice.
    let mut recap = session.clone();
    saved.merge_into(&mut recap);
    assert_eq!(ids(&recap), [json!(2), json!(1)]);
    assert_eq!(recap["fights"][1]["saved"], true);
    assert_eq!(recap["fights"][0]["saved"], false);

    // Next session: it comes back after the new fights, with an id of its own.
    let mut next = SavedFights::open(path.clone());
    let mut recap = json!({ "fights": [{ "id": 1, "live": false, "foes": ["Sac à patates"] }] });
    next.merge_into(&mut recap);
    assert_eq!(ids(&recap), [json!(1), json!("saved-1")]);
    assert_eq!(recap["fights"][1]["foes"], json!(["Ogrest"]));
    assert_eq!(recap["fights"][1]["isNew"], false);
    assert_eq!(recap["fights"][1]["savedId"], 1);

    // The bin forgets it for good.
    assert!(next.delete(1));
    assert_eq!(ids(&{ let mut r = json!({ "fights": [] }); SavedFights::open(path).merge_into(&mut r); r }), Vec::<Value>::new());
}
