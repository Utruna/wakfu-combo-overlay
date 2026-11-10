//! Auto-update from the app's own GitHub Releases (the latest.json that
//! .github/workflows/release.yml publishes). Downloads only on explicit
//! confirmation — never silently, so a background check never surprises the
//! user mid-stream.

use crate::app_state::LockExt;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::oneshot;

use crate::app_state::SETTINGS_WINDOW;

#[derive(Default)]
pub struct UpdateState {
    /// Kept so a settings window opened later still shows the last check's result.
    last_status: Mutex<Option<Value>>,
    /// Downloaded but not installed yet ("Plus tard"): installed on quit.
    pending: Mutex<Option<(Update, Vec<u8>)>>,
    in_progress: Mutex<bool>,
}

pub fn last_status(app: &AppHandle) -> Option<Value> {
    app.state::<UpdateState>().last_status.lock_safe().clone()
}

fn push_status(app: &AppHandle, status: Value) {
    *app.state::<UpdateState>().last_status.lock_safe() = Some(status.clone());
    if app.get_webview_window(SETTINGS_WINDOW).is_some() {
        let _ = app.emit_to(SETTINGS_WINDOW, "update:status", status);
    }
}

/// Shows a message box, attached to the settings window when it's open.
/// Resolves to true when the first (OK) button was chosen.
pub async fn ask(app: &AppHandle, kind: MessageDialogKind, title: &str, message: String, buttons: MessageDialogButtons) -> bool {
    let (tx, rx) = oneshot::channel();
    let mut dialog = app.dialog().message(message).title(title).kind(kind).buttons(buttons);
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        dialog = dialog.parent(&window);
    }
    dialog.show(move |ok| {
        let _ = tx.send(ok);
    });
    rx.await.unwrap_or(false)
}

async fn inform(app: &AppHandle, kind: MessageDialogKind, title: &str, message: String) {
    ask(app, kind, title, message, MessageDialogButtons::Ok).await;
}

/// `manual`: asked for from the tray or the settings page — "up to date" and
/// errors are only announced then; the silent startup check stays silent
/// when there's nothing new.
pub fn check(app: &AppHandle, manual: bool) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if cfg!(debug_assertions) {
            if manual {
                let message = "Recherche de mise à jour indisponible en développement (build non packagé).";
                inform(&app, MessageDialogKind::Info, "Mises à jour", message.into()).await;
            }
            return;
        }
        {
            let state = app.state::<UpdateState>();
            let mut in_progress = state.in_progress.lock_safe();
            if *in_progress {
                return;
            }
            *in_progress = true;
        }
        run_check(&app, manual).await;
        *app.state::<UpdateState>().in_progress.lock_safe() = false;
    });
}

async fn run_check(app: &AppHandle, manual: bool) {
    let pending_version = app.state::<UpdateState>().pending.lock_safe().as_ref().map(|(u, _)| u.version.clone());
    if let Some(version) = pending_version {
        offer_restart(app, version).await;
        return;
    }

    push_status(app, json!({ "status": "checking" }));
    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(err) => Err(err),
    };
    let update = match found {
        Ok(Some(update)) => update,
        Ok(None) => {
            push_status(app, json!({ "status": "not-available" }));
            if manual {
                let version = app.package_info().version.to_string();
                inform(app, MessageDialogKind::Info, "Mises à jour", format!("Tu es déjà à jour (v{version}).")).await;
            }
            return;
        }
        Err(err) => return report_error(app, manual, err.to_string()).await,
    };

    let version = update.version.clone();
    push_status(app, json!({ "status": "available", "version": version }));
    let download = ask(
        app,
        MessageDialogKind::Info,
        "Mise à jour disponible",
        format!(
            "Une nouvelle version ({version}) est disponible.\n\n\
             Télécharger maintenant ? L'installation se fera au redémarrage de l'application."
        ),
        MessageDialogButtons::OkCancelCustom("Télécharger".into(), "Plus tard".into()),
    )
    .await;
    if !download {
        return;
    }

    let mut downloaded: u64 = 0;
    let mut last_percent = -1.0;
    let progress_app = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let percent = total.map_or(0.0, |t| (downloaded as f64 / t as f64 * 100.0).floor());
                if percent != last_percent {
                    last_percent = percent;
                    push_status(&progress_app, json!({ "status": "downloading", "percent": percent }));
                }
            },
            || {},
        )
        .await;
    match bytes {
        Ok(bytes) => {
            push_status(app, json!({ "status": "downloaded", "version": version }));
            *app.state::<UpdateState>().pending.lock_safe() = Some((update, bytes));
            offer_restart(app, version).await;
        }
        Err(err) => report_error(app, true, err.to_string()).await,
    }
}

async fn offer_restart(app: &AppHandle, version: String) {
    let restart = ask(
        app,
        MessageDialogKind::Info,
        "Mise à jour prête",
        format!("La mise à jour vers la version {version} est prête.\n\nRedémarre l'application pour l'installer."),
        MessageDialogButtons::OkCancelCustom("Redémarrer maintenant".into(), "Plus tard".into()),
    )
    .await;
    if restart {
        install_pending(app, true);
    }
}

async fn report_error(app: &AppHandle, manual: bool, message: String) {
    push_status(app, json!({ "status": "error", "message": message }));
    if manual {
        inform(
            app,
            MessageDialogKind::Error,
            "Mises à jour",
            format!("Erreur lors de la recherche de mise à jour.\n\n{message}"),
        )
        .await;
    }
}

/// Installs the downloaded update, if any, then the app quits — and starts
/// again when `relaunch` is set. Returns false when there was nothing to
/// install (or it failed): the app is still running then.
pub fn install_pending(app: &AppHandle, relaunch: bool) -> bool {
    let Some((update, bytes)) = app.state::<UpdateState>().pending.lock_safe().take() else {
        return false;
    };
    match update.restart_after_install(relaunch).install(bytes) {
        // The installer closes the app itself (and relaunches it if asked).
        Ok(()) if cfg!(windows) => true,
        // Only the files were replaced: quitting is up to the app. A restart
        // goes through the regular exit, so the single-instance lock is
        // released before the new version looks for it.
        Ok(()) => {
            if relaunch {
                app.request_restart();
            } else {
                app.exit(0);
            }
            true
        }
        Err(err) => {
            eprintln!("[updates] Install failed: {err}");
            push_status(app, json!({ "status": "error", "message": err.to_string() }));
            false
        }
    }
}
