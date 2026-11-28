//! 音声エンジンが落ちたあとの復旧。
//! 落ちた理由の一文と、出す選択肢を決める。保存した VST の並びは、どの選択肢でも消さない。

/// 音声エンジンが落ちたときの記録（ホストの `audio-engine-exited` の中身）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Exit {
    pub cause: Cause,
    /// 落ちる直前の VST の操作（`load`・`restore` など）。
    pub op: Option<String>,
    pub path: Option<String>,
    pub class_id: Option<String>,
    pub name: Option<String>,
    pub host: Option<String>,
    pub input: Option<String>,
    pub output: Option<String>,
    /// 機器を開く途中（`false`）か、始めた直後（`true`）か。
    pub settling: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Cause {
    /// VST の操作の途中。
    Vst,
    /// 機器を開く途中か、始めた直後。
    Device,
    #[default]
    Unknown,
}

impl Cause {
    pub fn parse(text: &str) -> Cause {
        match text {
            "vst_operation" => Cause::Vst,
            "device_open" => Cause::Device,
            _ => Cause::Unknown,
        }
    }
}

/// 落ちた理由の一文に使う形。名前が分からなければ `None`（画面が「音声機器」「VST」と書く）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Summary {
    DeviceOpening(Option<String>),
    DeviceSettling(Option<String>),
    Vst { name: Option<String>, op: VstOp },
    Unknown,
}

/// 落ちる直前の VST の操作。知らない操作は `Other`。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VstOp {
    Load,
    Restore,
    SetState,
    GetState,
    OpenEditor,
    Remove,
    Resume,
    ProcessingSetup,
    Other,
}

impl VstOp {
    fn parse(op: Option<&str>) -> VstOp {
        match op {
            Some("load") => VstOp::Load,
            Some("restore") => VstOp::Restore,
            Some("set_state") => VstOp::SetState,
            Some("get_state") => VstOp::GetState,
            Some("open_editor") => VstOp::OpenEditor,
            Some("remove") => VstOp::Remove,
            Some("resume") => VstOp::Resume,
            Some("processing_setup") => VstOp::ProcessingSetup,
            _ => VstOp::Other,
        }
    }
}

/// 復旧の選択肢。並びはこの順。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Choice {
    /// 落ちる直前に操作していた VST を読まずに（並びには残して）始め直す。
    Exclude(Suspect),
    /// 並びをすべて読み直して始め直す。
    Reload,
    /// VST を読まずに（並びには残して）始め直す。
    Empty,
    /// 止めたままにする。
    KeepStopped,
    /// 止めたまま、接続の画面で別の機器を選ぶ。
    ChooseDevice,
}

/// 原因の候補の VST（確定ではない）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Suspect {
    pub path: String,
    pub class_id: Option<String>,
}

impl Suspect {
    /// 並びの VST がこの候補か。両方の種類（class_id）が分かれば、同じファイルの別の VST と見分ける。
    pub fn matches(&self, path: &str, class_id: Option<&str>) -> bool {
        self.path == path
            && match (self.class_id.as_deref(), class_id) {
                (Some(a), Some(b)) => a == b,
                _ => true,
            }
    }
}

/// 始め直すときに、読まずに並びへ残す VST。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Hold {
    All,
    One(Suspect),
}

impl Hold {
    pub fn holds(&self, path: &str, class_id: Option<&str>) -> bool {
        match self {
            Hold::All => true,
            Hold::One(suspect) => suspect.matches(path, class_id),
        }
    }
}

impl Choice {
    /// 始め直す選択肢なら、読まずに残す VST（`Reload` は `None`）。始め直さない選択肢は `None` の外側。
    pub fn restart(&self) -> Option<Option<Hold>> {
        match self {
            Choice::Exclude(suspect) => Some(Some(Hold::One(suspect.clone()))),
            Choice::Reload => Some(None),
            Choice::Empty => Some(Some(Hold::All)),
            Choice::KeepStopped | Choice::ChooseDevice => None,
        }
    }
}

impl Exit {
    pub fn is_device(&self) -> bool {
        self.cause == Cause::Device
    }

    /// 原因の候補の VST。機器のときは、残っている VST を候補にしない。
    pub fn suspect(&self) -> Option<Suspect> {
        if self.cause != Cause::Vst {
            return None;
        }
        Some(Suspect {
            path: nonempty(self.path.as_deref())?,
            class_id: nonempty(self.class_id.as_deref()),
        })
    }

    pub fn summary(&self) -> Summary {
        match self.cause {
            Cause::Device => {
                let mut devices: Vec<String> = Vec::new();
                for name in [&self.input, &self.output].into_iter().flatten() {
                    let name = name.trim();
                    if !name.is_empty() && !devices.iter().any(|d| d == name) {
                        devices.push(name.to_owned());
                    }
                }
                let name = if devices.is_empty() {
                    nonempty(self.host.as_deref())
                } else {
                    Some(devices.join(" / "))
                };
                if self.settling {
                    Summary::DeviceSettling(name)
                } else {
                    Summary::DeviceOpening(name)
                }
            }
            Cause::Vst => Summary::Vst {
                name: nonempty(self.name.as_deref()).or_else(|| {
                    let path = self.path.as_deref()?;
                    nonempty(path.split(['\\', '/']).rfind(|p| !p.is_empty()))
                }),
                op: VstOp::parse(self.op.as_deref()),
            },
            Cause::Unknown => Summary::Unknown,
        }
    }

    /// 出す選択肢。機器のときは機器を開かずに止めておくのをすすめる。
    pub fn choices(&self) -> Vec<Choice> {
        if self.is_device() {
            return vec![
                Choice::KeepStopped,
                Choice::ChooseDevice,
                Choice::Reload,
                Choice::Empty,
            ];
        }
        self.suspect()
            .map(Choice::Exclude)
            .into_iter()
            .chain([Choice::Reload, Choice::Empty, Choice::KeepStopped])
            .collect()
    }
}

fn nonempty(text: Option<&str>) -> Option<String> {
    text.map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vst(path: Option<&str>) -> Exit {
        Exit {
            cause: Cause::Vst,
            op: Some("open_editor".to_owned()),
            path: path.map(str::to_owned),
            class_id: Some("A".to_owned()),
            ..Exit::default()
        }
    }

    #[test]
    fn a_vst_crash_offers_to_hold_that_vst_first() {
        let exit = vst(Some(r"C:\VST\Comp.vst3"));
        let suspect = exit.suspect().unwrap();
        assert_eq!(
            exit.choices(),
            vec![
                Choice::Exclude(suspect.clone()),
                Choice::Reload,
                Choice::Empty,
                Choice::KeepStopped
            ]
        );
        assert_eq!(
            exit.summary(),
            Summary::Vst {
                name: Some("Comp.vst3".to_owned()),
                op: VstOp::OpenEditor
            }
        );
        assert!(suspect.matches(r"C:\VST\Comp.vst3", Some("A")));
        // 古い形式のスキャンで足した VST は種類が分からないので、ファイルだけで当てる。
        assert!(suspect.matches(r"C:\VST\Comp.vst3", None));
        assert!(!suspect.matches(r"C:\VST\Other.vst3", None));
        assert!(!suspect.matches(r"C:\VST\Comp.vst3", Some("B")));
        let any = Suspect {
            class_id: None,
            ..suspect
        };
        assert!(any.matches(r"C:\VST\Comp.vst3", Some("B")));
        assert_eq!(vst(Some("  ")).choices()[0], Choice::Reload);
        assert_eq!(Exit::default().summary(), Summary::Unknown);
        assert_eq!(Exit::default().choices()[0], Choice::Reload);
    }

    #[test]
    fn a_device_crash_suggests_staying_stopped_and_names_the_devices_once() {
        let exit = Exit {
            cause: Cause::Device,
            host: Some("ASIO".to_owned()),
            input: Some("Card".to_owned()),
            output: Some(" Card ".to_owned()),
            settling: true,
            path: Some("left.vst3".to_owned()),
            ..Exit::default()
        };
        assert_eq!(
            exit.summary(),
            Summary::DeviceSettling(Some("Card".to_owned()))
        );
        assert_eq!(exit.choices()[0], Choice::KeepStopped);
        assert!(exit.suspect().is_none());
        let unnamed = Exit {
            input: None,
            output: None,
            settling: false,
            ..exit
        };
        assert_eq!(
            unnamed.summary(),
            Summary::DeviceOpening(Some("ASIO".to_owned()))
        );
    }

    #[test]
    fn only_restarting_choices_hold_vsts() {
        let suspect = Suspect {
            path: "a".to_owned(),
            class_id: None,
        };
        assert_eq!(Choice::Reload.restart(), Some(None));
        assert_eq!(Choice::Empty.restart(), Some(Some(Hold::All)));
        assert_eq!(
            Choice::Exclude(suspect.clone()).restart(),
            Some(Some(Hold::One(suspect)))
        );
        assert_eq!(Choice::KeepStopped.restart(), None);
        assert!(Hold::All.holds("x", None));
    }
}
