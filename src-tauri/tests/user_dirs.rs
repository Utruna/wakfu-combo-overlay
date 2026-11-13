use std::fs;

use taktik_lib::user_dirs::copy_dir_if_absent;

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("taktik-userdirs-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
}

#[test]
fn the_old_folder_is_copied_to_the_new_one_and_left_in_place() {
    let root = scratch("copy");
    let (old, new) = (root.join("Wakfu Combo Overlay"), root.join("Taktik"));
    fs::create_dir_all(old.join("nested")).unwrap();
    fs::write(old.join("settings.json"), "{\"port\":1234}").unwrap();
    fs::write(old.join("nested").join("saved_fights.json"), "[]").unwrap();

    copy_dir_if_absent(&old, &new);

    assert_eq!(fs::read_to_string(new.join("settings.json")).unwrap(), "{\"port\":1234}");
    assert_eq!(fs::read_to_string(new.join("nested").join("saved_fights.json")).unwrap(), "[]");
    // The OBS loader page path pasted by users points into the old folder.
    assert!(old.join("settings.json").is_file());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn an_existing_new_folder_is_never_overwritten() {
    let root = scratch("keep");
    let (old, new) = (root.join("old"), root.join("new"));
    fs::create_dir_all(&old).unwrap();
    fs::create_dir_all(&new).unwrap();
    fs::write(old.join("settings.json"), "old").unwrap();
    fs::write(new.join("settings.json"), "new").unwrap();

    copy_dir_if_absent(&old, &new);

    assert_eq!(fs::read_to_string(new.join("settings.json")).unwrap(), "new");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn no_old_folder_means_nothing_is_created() {
    let root = scratch("none");
    let new = root.join("new");

    copy_dir_if_absent(&root.join("missing"), &new);

    assert!(!new.exists());
    let _ = fs::remove_dir_all(&root);
}
