// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .filter_module("tao", log::LevelFilter::Error)
        .filter_module("winit", log::LevelFilter::Error)
        .init();
    vst_host_lib::run()
}
