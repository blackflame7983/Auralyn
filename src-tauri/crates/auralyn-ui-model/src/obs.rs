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

/// 入力から接続の要求を作る。ホスト名が空か、ポートが不正なら作らない。
pub fn request(
    host: &str,
    port_text: &str,
    password: &str,
    use_saved: bool,
    saved: Option<&Target>,
) -> Option<Request> {
    let port = port(port_text)?;
    let host = host.trim();
    if host.is_empty() {
        return None;
    }
    let password = (!(use_saved && saved_matches(saved, host, port))).then(|| password.to_string());
    Some(Request {
        target: Target {
            host: host.to_string(),
            port,
        },
        password,
    })
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
        assert_eq!(request("  ", "4455", "", false, None), None);
        assert_eq!(request("localhost", "0", "", false, None), None);
    }

    #[test]
    fn debug_output_hides_the_password() {
        let request = request("localhost", "4455", "OBS_SECRET_CANARY", false, None).unwrap();
        assert!(!format!("{request:?}").contains("OBS_SECRET_CANARY"));
    }

    #[test]
    fn only_a_disconnected_target_can_be_edited() {
        assert!(State::Disconnected.editable());
        for state in [State::Checking, State::Connecting, State::Connected] {
            assert!(!state.editable());
        }
    }
}
