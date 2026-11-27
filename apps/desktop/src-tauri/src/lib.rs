//! mGit Tauri 셸.
//!
//! 커맨드·채널은 얇은 어댑터로만 두고, 실제 동작은 `mgit-core` 가 한다.
//! tauri-specta 로 Rust 타입에서 TS 바인딩(`packages/ipc/src/bindings.ts`)을 생성한다.

mod app_events;
mod commands;
mod commands_app;
mod commands_assist;
mod commands_branch_delete;
mod commands_changes;
mod commands_conflict;
mod commands_folder;
mod commands_fs;
mod commands_fs_operations;
mod commands_group;
mod commands_history;
mod commands_hosting;
mod commands_lfs;
mod commands_modules;
mod commands_pr;
mod commands_preview;
mod commands_pty;
mod commands_rebase;
mod commands_refs;
mod commands_remote;
mod commands_repo;
mod commands_runtime;
mod commands_safety;
mod commands_search;
mod commands_settings;
mod commands_submodule;
mod commands_tags;
mod commands_verify;
mod dto;
mod dto_diff;
mod error;
mod events;
#[cfg(test)]
mod export;
mod messages;
mod native_files;
mod pty;
mod runtime_profile;
mod state;

use std::path::Path;

use tauri::{Emitter, Manager};
use tauri_specta::{Builder, collect_commands};

/// specta 빌더. 커맨드 목록의 단일 출처이며 run() 과 바인딩 export 테스트가 공유한다
pub fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands_runtime::runtime_profile,
            commands_runtime::ui_settings_snapshot,
            commands_runtime::ui_settings_set,
            commands_runtime::perf_append,
            commands::git_version,
            commands::open_repo,
            commands::graph_window,
            commands::find_row,
            commands::repo_state,
            commands::refresh_repo,
            commands::reload_graph,
            commands::cancel_operation,
            commands::command_log_recent,
            commands::close_repo,
            commands_changes::stage_paths,
            commands_changes::unstage_paths,
            commands_changes::stage_all,
            commands_changes::unstage_all,
            commands_changes::work_tree_diff,
            commands_changes::work_tree_diff_document,
            commands_changes::commit_file_diff,
            commands_changes::commit_file_diff_document,
            commands_changes::stage_lines,
            commands_changes::discard_paths,
            commands_changes::rollback_paths,
            commands_changes::discard_lines,
            commands_changes::list_backups,
            commands_changes::restore_backup,
            commands_changes::delete_file_backups,
            commands_changes::delete_file_backups_before,
            commands_changes::prune_backups_daily,
            commands_changes::verify_staged,
            commands_changes::commit,
            commands_changes::last_commit_message,
            commands_changes::commit_message,
            commands_refs::commit_detail,
            commands_refs::commit_containing_refs,
            commands_refs::search_commits,
            commands_refs::checkout,
            commands_refs::create_branch,
            commands_refs::rename_branch,
            commands_refs::delete_branch,
            commands_refs::delete_remote_branch,
            commands_branch_delete::inspect_remote_branch_deletion,
            commands_branch_delete::inspect_folder_remote_branch_deletion,
            commands_branch_delete::delete_remote_branch_with_locals,
            commands_branch_delete::force_delete_local_branches,
            commands_refs::set_upstream,
            commands_refs::update_branch,
            commands_refs::create_tag,
            commands_tags::push_tags,
            commands_tags::delete_remote_tags,
            commands_tags::replace_remote_tags,
            commands_tags::delete_local_tags,
            commands_tags::remote_tags,
            commands_tags::lookup_remote_tags,
            commands_tags::fetch_tags,
            commands_tags::tag_list,
            commands_refs::merge,
            commands_refs::rebase,
            commands_refs::cherry_pick,
            commands_refs::revert,
            commands_refs::reset,
            commands_refs::op_continue,
            commands_refs::op_skip,
            commands_refs::op_abort,
            commands_refs::commit_graph_write,
            commands_remote::remote_add,
            commands_remote::remote_rename,
            commands_remote::remote_remove,
            commands_remote::remote_set_url,
            commands_remote::fetch,
            commands_remote::pull,
            commands_remote::push,
            commands_remote::list_stashes,
            commands_remote::stash_push,
            commands_remote::stash_apply,
            commands_remote::stash_pop,
            commands_remote::stash_drop,
            commands_remote::stash_files,
            commands_remote::stash_file_diff_document,
            commands_remote::suggest_worktree_path,
            commands_remote::worktree_add,
            commands_remote::worktree_remove_check,
            commands_remote::worktree_remove,
            commands_remote::worktree_prune,
            commands_repo::open_folder,
            commands_repo::folder_summaries,
            commands_repo::folder_rescan,
            commands_repo::close_folder,
            commands_repo::folder_open_repo_session,
            commands_repo::folder_release_repo_session,
            commands_group::groups_list,
            commands_group::group_check_paths,
            commands_group::group_create,
            commands_group::group_update,
            commands_group::group_delete,
            commands_group::open_group,
            commands_repo::scan_repos,
            commands_repo::clone_repo,
            commands_repo::clone_many,
            commands_repo::init_repo,
            commands_repo::gitignore_templates,
            commands_repo::recent_list,
            commands_repo::recent_pin,
            commands_repo::recent_remove,
            commands_repo::open_tabs_get,
            commands_repo::open_tabs_set,
            commands_repo::submodules,
            commands_repo::submodule_update,
            commands_repo::take_startup_paths,
            commands_repo::subscribe_app_events,
            commands_conflict::conflicts,
            commands_conflict::conflict_file,
            commands_conflict::resolve_file,
            commands_conflict::resolve_side,
            commands_conflict::resolve_delete,
            commands_conflict::unresolve,
            commands_assist::rename_conflicts,
            commands_assist::resolve_rename,
            commands_assist::conflict_origins,
            commands_assist::conflict_rules,
            commands_assist::conflict_rules_set,
            commands_assist::conflict_rules_apply,
            commands_assist::merge_tool_name,
            commands_assist::open_mergetool,
            commands_assist::resolution_review,
            commands_assist::remerge_diff,
            commands_assist::kept_resolutions,
            commands_assist::reapply_resolutions,
            commands_assist::kept_clear,
            commands_assist::rerere_status,
            commands_assist::rerere_set,
            commands_assist::rerere_forget,
            commands_app::credential_reply,
            commands_app::credential_forget,
            commands_app::external_apps_get,
            commands_app::external_apps_set,
            commands_app::auto_fetch_get,
            commands_app::auto_fetch_set,
            commands_app::open_external,
            commands_app::system_locale,
            commands_app::set_language,
            commands_safety::undo_state,
            commands_safety::undo,
            commands_safety::redo,
            commands_safety::backups,
            commands_safety::backup_restore,
            commands_safety::backup_delete,
            commands_safety::reflog,
            commands_safety::reflog_restore,
            commands_safety::worktree_lock,
            commands_safety::worktree_unlock,
            commands_safety::ignore_add,
            commands_safety::commit_templates,
            commands_safety::commit_templates_set,
            commands_safety::app_commit_templates,
            commands_safety::remove_index_lock,
            commands_rebase::rebase_plan_commits,
            commands_rebase::rebase_interactive,
            commands_rebase::reword_commit,
            commands_rebase::squash_into_parent,
            commands_rebase::worktree_wips,
            commands_history::graph_query,
            commands_history::set_graph_query,
            commands_history::graph_authors,
            commands_history::graph_layout_prefs,
            commands_history::set_graph_layout_prefs,
            commands_history::blame,
            commands_history::blame_contents,
            commands_history::revision_file_content,
            commands_history::compare_local_files,
            commands_history::comparison_commits,
            commands_history::resolve_revision,
            commands_history::compare_local_document,
            commands_history::file_history,
            commands_history::compare_refs,
            commands_history::compare_file_diff,
            commands_history::compare_file_diff_document,
            commands_history::range_files,
            commands_history::search_advanced,
            commands_history::open_difftool,
            commands_settings::signing_info,
            commands_settings::commit_signature,
            commands_settings::scan_staged_secrets,
            commands_settings::secret_ignores,
            commands_settings::secret_ignores_set,
            commands_settings::repo_settings,
            commands_settings::set_user,
            commands_settings::write_gitignore,
            commands_settings::perf_status,
            commands_settings::enable_perf,
            commands_settings::unshallow,
            commands_settings::notify,
            commands_hosting::hosting_accounts,
            commands_hosting::hosting_oauth,
            commands_hosting::hosting_oauth_set,
            commands_hosting::hosting_add_pat,
            commands_hosting::hosting_device_start,
            commands_hosting::hosting_device_finish,
            commands_hosting::hosting_remove,
            commands_hosting::hosting_repos,
            commands_hosting::hosting_urls,
            commands_hosting::profiles,
            commands_hosting::profiles_set,
            commands_hosting::apply_profile,
            commands_hosting::ssh_keys,
            commands_hosting::ssh_keygen,
            commands_hosting::open_url,
            commands_pr::hosting_remote_project,
            commands_pr::pull_requests,
            commands_pr::pr_templates,
            commands_pr::create_pull_request,
            commands_pr::checkout_pull_request,
            commands_pr::avatar,
            commands_folder::folder_settings,
            commands_folder::folder_settings_set,
            commands_folder::folder_batch,
            commands_folder::folder_stash_batches,
            commands_folder::folder_prune_backups_daily,
            commands_folder::folder_integration_preview,
            commands_folder::folder_changes,
            commands_folder::folder_branches,
            commands_folder::folder_stage,
            commands_folder::folder_unstage,
            commands_folder::folder_commit,
            commands_folder::folder_timeline_open,
            commands_folder::folder_timeline_info,
            commands_folder::folder_timeline_reload,
            commands_folder::folder_timeline_query_set,
            commands_folder::folder_timeline_scope_set,
            commands_folder::folder_timeline_authors,
            commands_folder::folder_timeline_prefs_set,
            commands_folder::folder_timeline_window,
            commands_folder::folder_timeline_find_row,
            commands_folder::folder_commit_detail,
            commands_folder::folder_commit_containing_refs,
            commands_folder::folder_commit_file_diff,
            commands_folder::folder_commit_file_diff_document,
            commands_fs_operations::fs_prepare_operation,
            commands_fs_operations::fs_execute_operation,
            commands_fs_operations::fs_cancel_operation,
            commands_fs_operations::fs_operation_progress,
            commands_fs_operations::fs_register_drop,
            commands_fs_operations::fs_clipboard_write,
            commands_fs_operations::fs_clipboard_read,
            commands_fs_operations::fs_recovery_warnings,
            commands_search::workspace_search,
            commands_search::workspace_search_cancel,
            commands_search::workspace_files,
            commands_search::workspace_replace_preview,
            commands_search::workspace_replace_apply,
            commands_search::workspace_replace_undo,
            commands_fs::fs_list_dir,
            commands_fs::fs_read_file,
            commands_fs::fs_read_image,
            commands_fs::fs_read_editable_file,
            commands_fs::fs_file_stamps,
            commands_fs::fs_save_file,
            commands_fs::fs_normalize_line_endings,
            commands_submodule::submodule_pointer_log,
            commands_submodule::submodule_add,
            commands_submodule::submodule_adopt,
            commands_submodule::submodule_remove,
            commands_submodule::submodule_set_branch,
            commands_submodule::submodule_update_remote,
            commands_submodule::submodule_sync,
            commands_submodule::submodule_batch,
            commands_submodule::submodule_unpushed,
            commands_modules::modules,
            commands_modules::module_overrides,
            commands_modules::module_overrides_set,
            commands_modules::module_scope,
            commands_modules::module_scope_set,
            commands_preview::merge_preview,
            commands_preview::merge_simulate,
            commands_preview::preview_file,
            commands_preview::conflict_radar,
            commands_preview::rebase_preview,
            commands_preview::isolated_merge,
            commands_preview::isolated_info,
            commands_preview::isolated_apply,
            commands_preview::isolated_discard,
            commands_preview::merge_with_options,
            commands_verify::syntax_compare,
            commands_verify::verify_command,
            commands_verify::verify_command_set,
            commands_verify::run_verify,
            commands_verify::worktree_init_command,
            commands_verify::worktree_init_command_set,
            commands_verify::run_worktree_init,
            commands_lfs::lfs_status,
            commands_lfs::lfs_install,
            commands_lfs::lfs_track,
            commands_lfs::lfs_untrack,
            commands_lfs::lfs_lock,
            commands_lfs::lfs_unlock,
            commands_pty::pty_open,
            commands_pty::pty_write,
            commands_pty::pty_resize,
            commands_pty::pty_close,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
}

/// TS 바인딩 생성 설정.
/// specta-typescript 는 i64·u64 내보내기를 금지하므로, 타임스탬프 같은 필드는 DTO 에서
/// `#[specta(type = specta_typescript::Number)]` 로 개별 표시한다.
pub fn ts_config() -> specta_typescript::Typescript {
    specta_typescript::Typescript::default()
        .header("// 자동 생성 파일 (tauri-specta). 직접 수정하지 말 것 — `pnpm gen:ipc` 로 재생성")
}

/// 생성된 바인딩 파일 경로 (crate 기준 상대 경로)
pub fn bindings_path() -> &'static str {
    concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/ipc/src/bindings.ts"
    )
}

/// Tauri 앱 조립: 플러그인, 상태(코어·저장소·감시자), 커맨드 핸들러, 디버그 빌드에서 바인딩 내보내기
pub fn run() {
    // 저장된 언어 설정을 전달받기 전의 시작 오류도 기본 영어로 표시한다.
    mgit_l10n::set(mgit_l10n::Lang::En);
    let profile = runtime_profile::RuntimeProfile::detect().expect("Failed to initialize runtime");
    let mut context = tauri::generate_context!();
    profile.configure(context.config_mut());
    let builder = specta_builder();

    #[cfg(debug_assertions)]
    builder
        .export(ts_config(), bindings_path())
        .expect("TS 바인딩 내보내기 실패");

    tauri::Builder::default()
        .manage(profile)
        // single-instance 는 반드시 첫 플러그인. 두 번째 실행의 인자를 열기 요청으로 바꾼다 (REPO-01)
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = existing_paths(argv.iter().skip(1), Path::new(&cwd));
            if let Some(state) = app.try_state::<state::AppState>() {
                state
                    .app_events
                    .emit(app_events::AppEvent::OpenRequested { paths });
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 앱 데이터 디렉터리(SQLite·백업)는 AppHandle 이 있어야 알 수 있다.
            // git 탐색·버전 검사는 창을 띄우기 전에 한 번만 한다 (실패해도 앱은 뜬다)
            let profile = app.state::<runtime_profile::RuntimeProfile>();
            let data_dir = if profile.root.is_some() {
                Some(app.path().app_data_dir()?)
            } else {
                app.path().app_data_dir().ok()
            };
            let file_data_dir = data_dir.clone().unwrap_or_else(std::env::temp_dir);
            if profile.root.is_some() {
                std::fs::create_dir_all(&file_data_dir)?;
            }
            app.manage(commands_runtime::UiSettings::new(file_data_dir.clone()));
            app.manage(commands_runtime::PerfLog::new(
                &profile,
                file_data_dir.clone(),
            ));
            let app_state =
                tauri::async_runtime::block_on(state::AppState::build_profile(data_dir, &profile));
            app.manage(commands_fs_operations::FileOperationsState::new(
                file_data_dir,
            ));
            let cwd = std::env::current_dir().unwrap_or_default();
            let argv: Vec<String> = std::env::args().skip(1).collect();
            app_state.set_startup_paths(existing_paths(argv.iter(), &cwd));
            app.manage(app_state);
            app.manage(pty::PtyState::default());
            install_quit_guard(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event
                && let Some(files) =
                    window.try_state::<commands_fs_operations::FileOperationsState>()
            {
                files.register_drop(paths);
            }
        })
        .invoke_handler(builder.invoke_handler())
        .build(context)
        .expect("mGit 실행 실패")
        .run(|app, event| {
            // 메뉴 종료·Cmd+Q도 프런트의 초안 저장 보호를 거친다. 보호가 끝나 창을 파괴하면 종료를 허용한다.
            if let tauri::RunEvent::ExitRequested { api, .. } = event
                && let Some(window) = app.get_webview_window("main")
            {
                api.prevent_exit();
                let _ = window.emit("mgit-close-requested", ());
            }
        });
}

/// 네이티브 기본 Quit은 macOS의 terminate:로 곧바로 종료하므로 같은 제목의 일반 메뉴로 교체한다.
/// 일반 메뉴 이벤트는 창 닫기와 같은 프런트 저장 확인을 거치고, OS 편집 메뉴는 그대로 유지한다.
fn install_quit_guard(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
    let menu = Menu::default(app)?;
    let native_quit = PredefinedMenuItem::quit(app, None)?;
    let quit_text = native_quit.text()?;
    let guarded_quit = MenuItem::with_id(
        app,
        "mgit-guarded-quit",
        &quit_text,
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    for item in menu.items()? {
        let MenuItemKind::Submenu(submenu) = item else {
            continue;
        };
        for (position, child) in submenu.items()?.into_iter().enumerate() {
            if let MenuItemKind::Predefined(predefined) = child
                && predefined.text()? == quit_text
            {
                submenu.remove(&predefined)?;
                submenu.insert(&guarded_quit, position)?;
            }
        }
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == "mgit-guarded-quit" {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("mgit-close-requested", ());
            } else {
                app.exit(0);
            }
        }
    });
    Ok(())
}

/// 인자 중 존재하는 경로만 절대 경로로 (상대 경로는 `cwd` 기준). 플래그는 버린다
fn existing_paths<'a>(args: impl Iterator<Item = &'a String>, cwd: &Path) -> Vec<String> {
    args.filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = Path::new(a);
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                cwd.join(p)
            }
        })
        .filter(|p| p.exists())
        .map(|p| p.display().to_string())
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    /// 릴리스 CSP: xterm·CodeMirror 가 넣는 `<style>` 은 허용하고 스크립트는 엄격하게 둔다.
    /// Tauri 가 `style-src` 에 nonce 를 넣으면 `'unsafe-inline'` 이 무효가 되므로 수정을 끈다
    #[test]
    fn release_csp_allows_runtime_styles_and_bundled_wasm_only() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let security = &conf["app"]["security"];
        let csp = security["csp"].as_str().unwrap();
        assert!(csp.contains("style-src 'self' 'unsafe-inline'"), "{csp}");
        let scripts = csp.split(';').find(|d| d.contains("script-src"));
        assert!(
            scripts.is_some_and(|d| d.trim() == "script-src 'self' 'wasm-unsafe-eval'"),
            "일반 eval과 인라인 스크립트를 허용하지 않아야 한다: {csp}"
        );
        assert!(
            !csp.split(';')
                .any(|d| d.trim().starts_with("default-src") && d.contains("unsafe"))
        );
        assert_eq!(
            security["dangerousDisableAssetCspModification"],
            serde_json::json!(["style-src"])
        );
    }

    /// 파일 API는 코어 경계로 제한한다. 저장 보호가 끝난 뒤에만 창을 파괴하도록 destroy 권한을 추가한다.
    /// 파일 시스템 플러그인 권한은 유지하고 CSP는 미리보기 이미지 외 네트워크를 제한하고 로컬 Worker·WASM만 허용한다.
    #[test]
    fn webview_capability_and_csp_are_pinned() {
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(cap["windows"], serde_json::json!(["main"]));
        assert_eq!(
            cap["permissions"],
            serde_json::json!([
                "core:default",
                "core:window:allow-destroy",
                "dialog:allow-open",
                "notification:default"
            ])
        );
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities");
        let mut files: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        files.sort();
        assert_eq!(files, ["default.json"], "capability 파일이 늘었다");

        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let security = &conf["app"]["security"];
        assert_eq!(
            security["csp"],
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; img-src 'self' data: http: https:; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost"
        );
        assert_eq!(
            security["devCsp"],
            "default-src 'self'; img-src 'self' data: http: https:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost ws://localhost:1420"
        );
        assert!(
            conf["plugins"]["fs"].is_null(),
            "fs 플러그인 범위 설정이 생겼다"
        );
        assert!(
            !include_str!("../Cargo.toml").contains("tauri-plugin-fs"),
            "fs 플러그인은 넣지 않는다"
        );
    }
}
