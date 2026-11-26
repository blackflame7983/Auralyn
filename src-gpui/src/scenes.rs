//! 設定の画面の「シーンの連動」：OBS でシーンが替わったら、同じ名前の構成を読むか、歌・雑談へ切り替える。
//! 判断は `auralyn-ui-model` の `scene_routing`、保存は `scene_file`。

use std::path::{Path, PathBuf};
use std::rc::Rc;

use auralyn_ui_model::live_modes::Mode;
use auralyn_ui_model::scene_routing::{Action, Issue, Routing, Strategy};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::Disableable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::i18n::{core, core_with, keys, Lang};
use crate::part::{choices, note, with_hint};
use crate::scene_file;

const STRATEGIES: [(Strategy, &str); 3] = [
    (Strategy::None, keys::SCENE_NONE),
    (Strategy::Profile, keys::SCENE_PROFILE),
    (Strategy::Mode, keys::SCENE_MODE),
];
const MODES: [(Mode, &str); 2] = [
    (Mode::Singing, keys::SCENE_SINGING),
    (Mode::Talk, keys::SCENE_TALK),
];

/// 画面での1つの操作（`MainView` が受けて描き直す）。
#[derive(Clone, Copy)]
pub enum Edit {
    Strategy(Strategy),
    Enabled(bool),
    Mode(usize, Mode),
    Add,
    Remove(usize),
    Save,
}

enum Saved {
    Done,
    /// シーン名が空か、同じ名前が2つある。
    Names,
    Failed(String),
}

pub type OnEdit = Rc<dyn Fn(Edit, &mut Window, &mut App)>;

pub struct ScenePanel {
    config_dir: PathBuf,
    /// 保存して効いている連動。
    saved: Routing,
    strategy: Strategy,
    enabled: bool,
    rows: Vec<(Entity<InputState>, Mode)>,
    /// 直前の保存の結果。
    done: Option<Saved>,
}

impl ScenePanel {
    pub fn new<V: 'static>(config_dir: &Path, window: &mut Window, cx: &mut Context<V>) -> Self {
        let saved = scene_file::load(config_dir);
        let rows = saved
            .scenes
            .iter()
            .map(|(name, mode)| {
                let name = name.clone();
                (
                    cx.new(|cx| InputState::new(window, cx).default_value(name)),
                    *mode,
                )
            })
            .collect();
        Self {
            config_dir: config_dir.to_path_buf(),
            strategy: saved.strategy,
            enabled: saved.enabled,
            saved,
            rows,
            done: None,
        }
    }

    /// OBS でシーンが替わったときの操作。
    pub fn action(&self, scene: &str) -> Option<Action> {
        self.saved.action(scene)
    }

    pub fn edit(&mut self, edit: Edit, window: &mut Window, cx: &mut App) {
        self.done = None;
        match edit {
            Edit::Strategy(strategy) => self.strategy = strategy,
            Edit::Enabled(enabled) => self.enabled = enabled,
            Edit::Mode(index, mode) => {
                if let Some(row) = self.rows.get_mut(index) {
                    row.1 = mode;
                }
            }
            Edit::Add => self
                .rows
                .push((cx.new(|cx| InputState::new(window, cx)), Mode::Singing)),
            Edit::Remove(index) => {
                if index < self.rows.len() {
                    self.rows.remove(index);
                }
            }
            Edit::Save => {
                let rows: Vec<(String, Mode)> = self
                    .rows
                    .iter()
                    .map(|(name, mode)| (name.read(cx).value().to_string(), *mode))
                    .collect();
                self.done = Some(match Routing::checked(self.strategy, self.enabled, &rows) {
                    Err(Issue::Names) => Saved::Names,
                    Ok(routing) => match scene_file::save(&self.config_dir, &routing) {
                        Ok(()) => {
                            self.saved = routing;
                            Saved::Done
                        }
                        Err(e) => Saved::Failed(e.to_string()),
                    },
                });
            }
        }
    }

    pub fn render(&self, lang: Lang, on: OnEdit) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .pt_3()
            .border_t_1()
            .border_color(crate::color::border())
            .child(with_hint(
                "scene-hint",
                lang,
                core(lang, keys::SCENE_LEAD),
                div()
                    .font_weight(FontWeight::MEDIUM)
                    .child(core(lang, keys::SCENE_TITLE)),
            ))
            .child(choices(
                "scene-strategy",
                lang,
                &STRATEGIES,
                Some(self.strategy),
                {
                    let on = on.clone();
                    move |strategy, window, cx| on(Edit::Strategy(strategy), window, cx)
                },
            ))
            .child(
                Checkbox::new("scene-enabled")
                    .checked(self.enabled && self.strategy != Strategy::None)
                    .disabled(self.strategy == Strategy::None)
                    .label(core(lang, keys::SCENE_ENABLE))
                    .on_click({
                        let on = on.clone();
                        move |checked, window, cx| on(Edit::Enabled(*checked), window, cx)
                    }),
            )
            .when(self.strategy == Strategy::Mode, |this| {
                this.child(note(core(lang, keys::SCENE_MODE_LEAD)))
                    .children(self.rows.iter().enumerate().map(|(index, (name, mode))| {
                        let on_mode = on.clone();
                        let on_remove = on.clone();
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap_2()
                            .child(div().flex_1().min_w(px(160.)).child(
                                Input::new(name).aria_label(core_with(
                                    lang,
                                    keys::SCENE_NAME_N,
                                    &[("arg0", &(index + 1))],
                                )),
                            ))
                            .child(choices(
                                format!("scene-mode-{index}"),
                                lang,
                                &MODES,
                                Some(*mode),
                                move |mode, window, cx| {
                                    on_mode(Edit::Mode(index, mode), window, cx)
                                },
                            ))
                            .child(
                                Button::new(SharedString::from(format!("scene-remove-{index}")))
                                    .label(core_with(
                                        lang,
                                        keys::SCENE_REMOVE,
                                        &[("n", &(index + 1))],
                                    ))
                                    .ghost()
                                    .on_click(move |_, window, cx| {
                                        on_remove(Edit::Remove(index), window, cx)
                                    }),
                            )
                    }))
                    .child(div().child({
                        let on = on.clone();
                        Button::new("scene-add")
                            .label(core(lang, keys::SCENE_ADD))
                            .ghost()
                            .on_click(move |_, window, cx| on(Edit::Add, window, cx))
                    }))
            })
            .child(
                div().child(
                    Button::new("scene-save")
                        .label(core(lang, keys::SCENE_SAVE))
                        .outline()
                        .on_click(move |_, window, cx| on(Edit::Save, window, cx)),
                ),
            )
            .when_some(self.done.as_ref(), |this, done| {
                this.child(note(match done {
                    Saved::Done => core(lang, keys::SCENE_SAVED).to_string(),
                    Saved::Names => core(lang, keys::SCENE_NAMES).to_string(),
                    Saved::Failed(e) => format!("{} {e}", core(lang, keys::SCENE_SAVE_FAILED)),
                }))
            })
    }
}
