//! Auralyn の GPUI 版。今は右の列（本番中の操作）と、ホームの音の流れの帯を持つ。決定と知見は docs/gpui/。
//!
//! 使い方：`auralyn-gpui [--lang ja|en] [--config-dir <フォルダ>]`
//! 言語を指定しなければ、保存した表示言語（Tauri 版と共通）で開く。
//! 既定の設定のフォルダは、Tauri 版と同じ `%APPDATA%\com.kuro7983.auralynhost`。保存した最後の音声の設定で開始する。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod color;
mod connect;
mod desktop;
mod engine;
mod home;
mod i18n;
mod live;
mod locale_file;
mod measure;
mod mix;
mod part;
mod post_mix;
mod settings;
mod setups;
mod shell;
mod sound;
mod store;
mod view;
mod voice;
mod vst;

use std::path::PathBuf;

use gpui_kit::*;

use crate::i18n::Lang;

struct Args {
    /// 引数で指定した言語。
    lang: Option<Lang>,
    config_dir: PathBuf,
}

fn parse_args() -> Args {
    let mut lang = None;
    let mut config_dir = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--lang" => {
                lang = match args.next().as_deref() {
                    Some("ja") => Some(Lang::Ja),
                    Some("en") => Some(Lang::En),
                    other => {
                        eprintln!("不明な言語: {other:?}");
                        None
                    }
                }
            }
            "--config-dir" => config_dir = args.next().map(PathBuf::from),
            other => eprintln!("不明な引数: {other}"),
        }
    }
    let config_dir = config_dir.unwrap_or_else(|| {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join("com.kuro7983.auralynhost")
    });
    Args { lang, config_dir }
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = parse_args();
    log::info!("設定のフォルダ: {}", args.config_dir.display());
    let lang = args
        .lang
        .or_else(|| locale_file::load(&args.config_dir))
        .unwrap_or(Lang::Ja);
    let config_dir = args.config_dir.clone();
    let engine = engine::Engine::start(args.config_dir);
    gpui_kit::application()
        .with_assets(assets::AppAssets)
        .run(move |cx| {
            gpui_kit::init(cx);
            gpui_kit::component::Theme::change(gpui_kit::component::ThemeMode::Dark, None, cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(1024.), px(768.)),
                    cx,
                ))),
                window_min_size: Some(size(px(900.), px(600.))),
                titlebar: Some(TitlebarOptions {
                    title: Some("Auralyn (GPUI)".into()),
                    ..Default::default()
                }),
                ..Default::default()
            };
            let (_, view) = gpui_kit::open_window(options, cx, |window, cx| {
                cx.new(|cx| view::MainView::new(engine, lang, config_dir, window, cx))
            })
            .expect("窓を開けません");
            // 保存は終わり方（トレイの「終了」・窓を閉じる・Windows のサインアウトやシャットダウン）によらず、終了の直前に1回だけ行う。
            cx.on_app_quit(move |cx| {
                view.read(cx).save_before_quit();
                async {}
            })
            .detach();
            cx.on_window_closed(|cx, _| cx.quit()).detach();
        });
}
