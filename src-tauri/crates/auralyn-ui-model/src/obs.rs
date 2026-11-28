//! OBS との接続：接続先の入力と、保存したパスワードを使うか。接続そのものと保存は vst-host の `obs`・`obs_credentials`。

pub const DEFAULT_HOST: &str = "localhost";
pub const DEFAULT_PORT: u16 = 4455;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    /// 画面を開いてから、まだ状態を読めていない。
    Checking,
    Disconnected,
    Connecting,
    Connected,
}

impl State {
    /// 接続先を書き換えられるか。接続中に変えると、出ている接続先と実際の接続先がずれる。
    pub fn editable(self) -> bool {
        self == State::Disconnected
    }
}

/// 接続の要求。`password` が `None` なら保存したパスワードを使う。`Some("")` は認証なし。
#[derive(Clone, PartialEq, Eq)]
pub struct Request {
    pub target: Target,
    pub password: Option<String>,
}

/// パスワードはログへ出さない。
impl std::fmt::Debug for Request {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Request")
            .field("target", &self.target)
            .field("password", &self.password.as_ref().map(|_| "<hidden>"))
            .finish()
    }
}

pub fn port(text: &str) -> Option<u16> {
    text.trim().parse().ok().filter(|port| *port != 0)
}

/// 保存したパスワードがこの接続先のものか。保存する側と同じく、ホスト名は前後の空白を除き小文字で比べる。
pub fn saved_matches(saved: Option<&Target>, host: &str, port: u16) -> bool {
    saved.is_some_and(|saved| saved.host == host.trim().to_ascii_lowercase() && saved.port == port)
}

/// 接続の要求を作れない理由。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Invalid {
    Host,
    Port,
}

/// 入力から接続の要求を作る。ホスト名が空か、ポートが不正なら作らない（ホスト名を先に見る）。
pub fn request(
    host: &str,
    port_text: &str,
    password: &str,
    use_saved: bool,
    saved: Option<&Target>,
) -> Result<Request, Invalid> {
    let host = host.trim();
    if host.is_empty() {
        return Err(Invalid::Host);
    }
    let port = port(port_text).ok_or(Invalid::Port)?;
    let password = (!(use_saved && saved_matches(saved, host, port))).then(|| password.to_string());
    Ok(Request {
        target: Target {
            host: host.to_string(),
            port,
        },
        password,
    })
}

/// 到達確認のテスト音の長さ（Tauri 版と同じ）。
pub const REACH_MS: u32 = 1500;
/// 確認の結果がまだ今の条件のものかを、設定の画面を出している間に読み直す間隔。
pub const RECHECK_MS: u64 = 2000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reached {
    Yes,
    No,
    /// OBS がメーターを返さない。手で確かめてもらう。
    Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Confirmed,
    NotReached,
    Unsupported,
    /// 確かめたあとに OBS の対象・接続・音声の条件が変わった。確かめ直してもらう。
    Stale,
}

/// テスト音での到達確認の結果。
#[derive(Clone, Debug, PartialEq)]
pub struct Reach {
    pub reached: Reached,
    pub peak_db: Option<f32>,
    /// 今の条件のものかを聞くときの番号。無ければ聞けない。
    pub operation: Option<String>,
    pub current: bool,
}

impl Reach {
    pub fn new(reached: Reached, peak_db: Option<f32>, operation: Option<String>) -> Self {
        Self {
            reached,
            peak_db,
            operation,
            current: true,
        }
    }

    pub fn verdict(&self) -> Verdict {
        match self.reached {
            Reached::Unsupported => Verdict::Unsupported,
            _ if !self.current => Verdict::Stale,
            Reached::Yes => Verdict::Confirmed,
            Reached::No => Verdict::NotReached,
        }
    }

    /// 読み直すときの番号。一度古くなったら戻らない（ホストも戻さない）ので、もう聞かない。
    pub fn recheck(&self) -> Option<&str> {
        self.operation
            .as_deref()
            .filter(|_| self.current && self.reached != Reached::Unsupported)
    }

    /// 読み直した答え。別の確認への答え（遅れて届いたもの）は無視する。
    pub fn answer(&mut self, operation: &str, current: bool) {
        if self.operation.as_deref() == Some(operation) {
            self.current &= current;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved() -> Target {
        Target {
            host: "studio-pc".into(),
            port: 4455,
        }
    }

    #[test]
    fn ports_must_be_numbers_above_zero() {
        assert_eq!(port(" 4455 "), Some(4455));
        for text in ["", "0", "-1", "65536", "44a"] {
            assert_eq!(port(text), None, "{text}");
        }
    }

    #[test]
    fn saved_password_is_used_only_for_the_same_target_and_when_chosen() {
        let saved = saved();
        let use_saved = request(" Studio-PC ", "4455", "typed", true, Some(&saved)).unwrap();
        assert_eq!(use_saved.password, None);
        assert_eq!(use_saved.target.host, "Studio-PC");
        let typed = request("studio-pc", "4455", "typed", false, Some(&saved)).unwrap();
        assert_eq!(typed.password.as_deref(), Some("typed"));
        let other_port = request("studio-pc", "4456", "", true, Some(&saved)).unwrap();
        assert_eq!(other_port.password.as_deref(), Some(""));
        let nothing_saved = request("studio-pc", "4455", "", true, None).unwrap();
        assert_eq!(nothing_saved.password.as_deref(), Some(""));
    }

    #[test]
    fn blank_hosts_and_bad_ports_make_no_request() {
        assert_eq!(request("  ", "0", "", false, None), Err(Invalid::Host));
        assert_eq!(
            request("localhost", "0", "", false, None),
            Err(Invalid::Port)
        );
    }

    #[test]
    fn debug_output_hides_the_password() {
        let request = request("localhost", "4455", "OBS_SECRET_CANARY", false, None).unwrap();
        assert!(!format!("{request:?}").contains("OBS_SECRET_CANARY"));
    }

    #[test]
    fn a_reach_goes_stale_once_and_stays_stale() {
        let mut reach = Reach::new(Reached::Yes, Some(-12.0), Some("3".into()));
        assert_eq!(reach.verdict(), Verdict::Confirmed);
        assert_eq!(reach.recheck(), Some("3"));
        reach.answer("2", false);
        assert_eq!(reach.verdict(), Verdict::Confirmed);
        reach.answer("3", false);
        assert_eq!(reach.verdict(), Verdict::Stale);
        reach.answer("3", true);
        assert_eq!(reach.verdict(), Verdict::Stale);
        assert_eq!(reach.recheck(), None);
    }

    #[test]
    fn unsupported_meters_are_never_stale_or_rechecked() {
        let mut reach = Reach::new(Reached::Unsupported, None, None);
        reach.current = false;
        assert_eq!(reach.verdict(), Verdict::Unsupported);
        assert_eq!(reach.recheck(), None);
        let not_reached = Reach::new(Reached::No, None, Some("1".into()));
        assert_eq!(not_reached.verdict(), Verdict::NotReached);
    }

    #[test]
    fn only_a_disconnected_target_can_be_edited() {
        assert!(State::Disconnected.editable());
        for state in [State::Checking, State::Connecting, State::Connected] {
            assert!(!state.editable());
        }
    }
}
