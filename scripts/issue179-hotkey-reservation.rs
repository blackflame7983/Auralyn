//! テスト専用のキー競合。標準入力EOFまたは上限時間でこのプロセスの登録だけを解放する。
use std::io::{self, Write};
use std::sync::mpsc;
use std::time::Duration;

#[link(name = "user32")]
extern "system" {
    fn RegisterHotKey(window: *mut core::ffi::c_void, id: i32, modifiers: u32, key: u32) -> i32;
    fn UnregisterHotKey(window: *mut core::ffi::c_void, id: i32) -> i32;
}

fn main() {
    // Alt+Shift+F9。Windowsキーと、他アプリの登録変更は使わない。
    if unsafe { RegisterHotKey(core::ptr::null_mut(), 179, 0x0001 | 0x0004 | 0x4000, 0x78) } == 0 {
        eprintln!("予約失敗: {}", io::Error::last_os_error());
        std::process::exit(1);
    }
    println!("READY");
    io::stdout().flush().expect("test readiness");
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = io::stdin().read_line(&mut line);
        let _ = send.send(());
    });
    let _ = receive.recv_timeout(Duration::from_secs(120));
    if unsafe { UnregisterHotKey(core::ptr::null_mut(), 179) } == 0 {
        eprintln!("解放失敗: {}", io::Error::last_os_error());
        std::process::exit(1);
    }
}
