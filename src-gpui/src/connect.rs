//! 接続の画面：接続方式・マイク・出力先を選び、その機器で開始する。
//! 周波数とバッファは、選んだ機器が受け付ける値と「自動」から選ぶ。
//! 最初に選んでおく項目は `auralyn-ui-model` の `connect` で決める。ASIO では入力のペアと出力の返し方も選ぶ。
//! ASIO で動いている間は、どの入力に音が来ているかを出し、選んでいるペアが無音なら音が来ているペアへの切り替えを勧める。

use auralyn_ui_model::channel_signal;
use auralyn_ui_model::connect::{self, AppSource, Device, Input, Output, Purpose, Routing, Saved};
use auralyn_ui_model::mix;
use auralyn_ui_model::session::Phase;
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::select::{Select, SelectState};
use gpui_kit::component::{Disableable as _, Icon, IndexPath, Sizable as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::i18n::{core, core_with, keys, Lang};
use crate::part::{hint, note, shift, with_hint};

type Choices = SelectState<Vec<SharedString>>;

pub struct ConnectPage {
    devices: Vec<Device>,
    saved: Option<Saved>,
    lang: Lang,
    /// 接続方式。選び直したら `fill` で機器を選び直す（`MainView` が購読する）。
    pub host: Entity<Choices>,
    /// マイクと出力先。選び直したら `fill_values` で周波数とバッファの候補を作り直す（`MainView` が購読する）。
    pub input: Entity<Choices>,
    pub output: Entity<Choices>,
    rate: Entity<Choices>,
    buffer: Entity<Choices>,
    /// 周波数とバッファの選択肢の値。選択肢の先頭は「自動」で、ここには入れない。
    rates: Vec<u32>,
    buffers: Vec<u32>,
    /// ASIO の入力のペア・出力の返し方・出力のペア。返し方を選び直したら描き直す（`MainView` が購読する）。
    input_pair: Entity<Choices>,
    pub output_mode: Entity<Choices>,
    output_pair: Entity<Choices>,
    input_pairs: Vec<[usize; 2]>,
    output_pairs: Vec<[usize; 2]>,
    /// 選んでいる入力・出力のチャンネル数。0 は分からない（保存したペアだけが候補に出る）。
    channels: [u16; 2],
    /// 入力元（マイク・仮想ケーブルか、アプリの音声か）。選び直したら描き直す（`MainView` が購読する）。
    pub source: Entity<Choices>,
    purpose: Entity<Choices>,
    /// 入力にするアプリと、その原音の出力先。アプリを選び直したら出力先を入れ直す（`MainView` が購読する）。
    pub app: Entity<Choices>,
    route: Entity<Choices>,
    /// 最後に読んだ起動中のアプリ（配信ミックスのオケと同じ一覧）。
    apps: Vec<mix::App>,
    apps_failed: Option<String>,
    /// 使い道ごとに、最後に始めた接続（Tauri 版の使い道の切り替え）。
    pub remembered: Vec<Saved>,
}

/// 出力の返し方の札と説明。並びは `Output::row`。
const OUTPUT_MODES: [(&str, &str); 3] = [
    (keys::ROUTING_INDEPENDENT, keys::ROUTING_INDEPENDENT_HINT),
    (keys::ROUTING_INSERT, keys::ROUTING_INSERT_HINT),
    (keys::ROUTING_LEGACY, keys::ROUTING_LEGACY_HINT),
];

impl ConnectPage {
    pub fn new<V: 'static>(lang: Lang, window: &mut Window, cx: &mut Context<V>) -> Self {
        let mut choices =
            |cx: &mut Context<V>| cx.new(|cx| SelectState::new(Vec::new(), None, window, cx));
        Self {
            devices: Vec::new(),
            saved: None,
            lang,
            host: choices(cx),
            input: choices(cx),
            output: choices(cx),
            rate: choices(cx),
            buffer: choices(cx),
            rates: Vec::new(),
            buffers: Vec::new(),
            input_pair: choices(cx),
            output_mode: choices(cx),
            output_pair: choices(cx),
            input_pairs: Vec::new(),
            output_pairs: Vec::new(),
            channels: [0, 0],
            source: choices(cx),
            purpose: choices(cx),
            app: choices(cx),
            route: choices(cx),
            apps: Vec::new(),
            apps_failed: None,
            remembered: Vec::new(),
        }
    }

    pub fn set_devices(
        &mut self,
        devices: Vec<Device>,
        saved: Option<Saved>,
        lang: Lang,
        window: &mut Window,
        cx: &mut App,
    ) {
        let hosts = connect::hosts(&devices);
        let selected = connect::initial_host(&hosts, saved.as_ref());
        self.devices = devices;
        self.saved = saved;
        self.lang = lang;
        let names = hosts.into_iter().map(SharedString::from).collect();
        set(&self.host, names, selected, window, cx);
        self.fill(window, cx);
    }

    /// 選んでいる接続方式の機器を、マイクと出力先の選択肢に入れる。周波数とバッファは保存した値から選び直す。
    pub fn fill(&mut self, window: &mut Window, cx: &mut App) {
        let host = self.host_name(cx);
        for (state, is_input) in [(&self.input, true), (&self.output, false)] {
            let choices = connect::of_host(&self.devices, &host, is_input);
            let selected = connect::initial_device(&choices, self.saved.as_ref(), is_input);
            let names = connect::labels(&choices)
                .into_iter()
                .map(SharedString::from)
                .collect();
            set(state, names, selected, window, cx);
        }
        let saved = self.saved.as_ref();
        let rate = connect::saved_value(saved, &host, |s| s.sample_rate);
        let buffer = connect::saved_value(saved, &host, |s| s.buffer_size);
        // 一度入れたあと（機器の一覧の読み直し・接続方式の選び直し）は、選んでいた入力元と使い道を保つ。
        let (app, purpose) = if self.source.read(cx).selected_index(cx).is_none() {
            (
                connect::starts_with_app(saved, &host),
                saved.map(|s| s.purpose).unwrap_or_default(),
            )
        } else {
            (self.uses_app(cx), self.chosen_purpose(cx))
        };
        self.fill_source(app, purpose, window, cx);
        self.fill_values(rate, buffer, window, cx);
        self.fill_routing(None, window, cx);
    }

    /// 入力元と使い道の選択肢を入れる。アプリの音声は WASAPI のときだけ選べる。
    fn fill_source(&mut self, app: bool, purpose: Purpose, window: &mut Window, cx: &mut App) {
        let lang = self.lang;
        let mut sources = vec![SharedString::from(core(lang, keys::SOURCE_DEVICE))];
        if connect::allows_app(&self.host_name(cx)) {
            sources.push(core(lang, keys::SOURCE_APP).into());
        }
        let row = usize::from(app && sources.len() > 1);
        set(&self.source, sources, Some(row), window, cx);
        let purposes = Purpose::ALL
            .iter()
            .map(|p| SharedString::from(core(lang, purpose_label(*p))))
            .collect();
        let row = Purpose::ALL.iter().position(|p| *p == purpose);
        set(&self.purpose, purposes, row, window, cx);
        let current = self.app_source(cx);
        self.fill_apps(current, window, cx);
    }

    /// もう一方の使い道で最後に始めた接続。
    fn other_usage(&self, cx: &App) -> Option<&Saved> {
        let target = self.chosen_purpose(cx).other();
        self.remembered.iter().find(|s| s.purpose == target)
    }

    /// もう一方の使い道で最後に始めた接続を、選択に入れる。音は変えない（開始で反映する）。
    pub fn switch_purpose(&mut self, window: &mut Window, cx: &mut App) {
        let Some(saved) = self.other_usage(cx).cloned() else {
            return;
        };
        // 選んでいた入力元・アプリを外し、残した接続から選び直す。
        for state in [&self.source, &self.app] {
            state.update(cx, |state, cx| state.set_selected_index(None, window, cx));
        }
        self.set_devices(self.devices.clone(), Some(saved), self.lang, window, cx);
    }

    /// 入力にアプリの音声を選んでいるか。
    pub fn uses_app(&self, cx: &App) -> bool {
        self.source.read(cx).selected_index(cx).map(|i| i.row) == Some(1)
    }

    fn chosen_purpose(&self, cx: &App) -> Purpose {
        self.purpose
            .read(cx)
            .selected_index(cx)
            .and_then(|i| Purpose::ALL.get(i.row).copied())
            .unwrap_or_default()
    }

    /// 起動中のアプリを読んだ。前に選んでいたアプリ（無ければ保存したアプリ）を選び直す。
    pub fn set_apps(
        &mut self,
        result: Result<Vec<mix::App>, String>,
        window: &mut Window,
        cx: &mut App,
    ) {
        // 選んでいたアプリは、一覧を差し替える前に読む（行の番号は新しい一覧では別のアプリを指す）。
        let current = self.app_source(cx);
        match result {
            Ok(apps) => {
                self.apps = apps;
                self.apps_failed = None;
            }
            Err(message) => self.apps_failed = Some(message),
        }
        self.fill_apps(current, window, cx);
    }

    /// アプリの選択肢を入れる。`current`（選んでいたアプリ）、無ければ保存したアプリがまだあれば選ぶ。
    fn fill_apps(
        &mut self,
        current: Option<(String, AppSource)>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let saved = self.saved.as_ref().and_then(|s| s.app.clone());
        let keep = current
            .as_ref()
            .map(|(id, s)| (Some(id.as_str()), s))
            .or(saved.as_ref().map(|s| (None, s)));
        let row = keep.and_then(|(id, s)| mix::find_app(&self.apps, id, &s.key, Some(&s.route)));
        let lang = self.lang;
        let names = self
            .apps
            .iter()
            .enumerate()
            .map(|(i, app)| {
                let twins = self.apps.iter().filter(|a| a.name == app.name).count();
                SharedString::from(if twins > 1 {
                    format!(
                        "{}{}",
                        app.name,
                        core_with(lang, keys::APP_CANDIDATE, &[("number", &(i + 1))])
                    )
                } else {
                    app.name.clone()
                })
            })
            .collect();
        set(&self.app, names, row, window, cx);
        let route = keep.map(|(_, s)| s.route.clone());
        self.fill_route(route, window, cx);
    }

    /// 選んだアプリの原音の出力先を入れる。`keep` があれば選び、無ければ先頭。
    fn fill_route(&mut self, keep: Option<String>, window: &mut Window, cx: &mut App) {
        let lang = self.lang;
        let routes = self
            .chosen_app(cx)
            .map(|a| a.routes.clone())
            .unwrap_or_default();
        let names = routes
            .iter()
            .map(|r| {
                let state = if r.muted {
                    keys::APP_MUTED
                } else {
                    keys::APP_MUTE_NEEDED
                };
                SharedString::from(format!("{}（{}）", r.name, core(lang, state)))
            })
            .collect();
        let row = keep
            .and_then(|k| routes.iter().position(|r| r.id == k))
            .or((!routes.is_empty()).then_some(0));
        set(&self.route, names, row, window, cx);
    }

    /// アプリを選び直したとき。
    pub fn app_changed(&mut self, window: &mut Window, cx: &mut App) {
        self.fill_route(None, window, cx);
    }

    fn chosen_app(&self, cx: &App) -> Option<&mix::App> {
        self.apps.get(self.app.read(cx).selected_index(cx)?.row)
    }

    /// 選んでいるアプリの候補と、入力にする音の元。
    fn app_source(&self, cx: &App) -> Option<(String, AppSource)> {
        let app = self.chosen_app(cx)?;
        let route = app
            .routes
            .get(self.route.read(cx).selected_index(cx)?.row)?;
        Some((
            app.id.clone(),
            AppSource {
                key: app.key.clone(),
                name: app.name.clone(),
                route: route.id.clone(),
            },
        ))
    }

    /// 開始に使う入力・使い道・出力先。選び終わっていなければ `None`。
    pub fn start_choice(&self, cx: &App) -> Option<(Input, Purpose, Device)> {
        let purpose = self.chosen_purpose(cx);
        if self.uses_app(cx) {
            let (candidate_id, source) = self.app_source(cx)?;
            let output = self.chosen_output(cx)?;
            return Some((
                Input::App {
                    candidate_id,
                    source,
                },
                purpose,
                output,
            ));
        }
        let (input, output) = self.chosen(cx)?;
        Some((Input::Device(input), purpose, output))
    }

    /// 選んでいる出力先（アプリの音声のときに使う。WASAPI だけ）。
    fn chosen_output(&self, cx: &App) -> Option<Device> {
        let host = self.host_name(cx);
        let label = self.output.read(cx).selected_value()?;
        connect::by_label(&self.devices, &host, false, label).cloned()
    }

    /// 選んでいる機器が受け付ける周波数とバッファを選択肢に入れる。`rate`・`buffer` が候補にあれば選び、無ければ「自動」。
    fn fill_values(
        &mut self,
        rate: Option<u32>,
        buffer: Option<u32>,
        window: &mut Window,
        cx: &mut App,
    ) {
        // アプリの音声のときは、出力先が受け付ける値から選ぶ。
        let devices = if self.uses_app(cx) {
            self.chosen_output(cx).map(|o| (o.clone(), o))
        } else {
            self.chosen(cx)
        };
        let (rates, buffers) = match devices {
            Some((input, output)) => {
                let asio = connect::shares_device(&input.host);
                (
                    connect::rates(&input, &output, asio, rate),
                    connect::buffers(&input, buffer),
                )
            }
            None => (Vec::new(), Vec::new()),
        };
        let lang = self.lang;
        let samples = core(lang, keys::SAMPLES).trim();
        set_values(&self.rate, &rates, rate, lang, khz, window, cx);
        set_values(
            &self.buffer,
            &buffers,
            buffer,
            lang,
            |size| format!("{size} {samples}"),
            window,
            cx,
        );
        self.rates = rates;
        self.buffers = buffers;
    }

    /// マイクか出力先を選び直したとき。選んでいた周波数とバッファは、新しい機器でも候補にあれば残す。
    pub fn devices_changed(&mut self, window: &mut Window, cx: &mut App) {
        let (rate, buffer) = self.values(cx);
        self.fill_values(rate, buffer, window, cx);
        self.fill_routing(None, window, cx);
    }

    /// 表示言語を替えた。選んでいる値は保ったまま、札を作り直す。
    pub fn set_lang(&mut self, lang: Lang, window: &mut Window, cx: &mut App) {
        self.lang = lang;
        let routing = self.routing(cx);
        let (rate, buffer) = self.values(cx);
        let (app, purpose) = (self.uses_app(cx), self.chosen_purpose(cx));
        self.fill_source(app, purpose, window, cx);
        self.fill_values(rate, buffer, window, cx);
        self.fill_routing(Some(routing), window, cx);
    }

    /// ASIO の割り当ての選択肢を入れる。`keep` が無ければ、保存した同じドライバーの割り当てか既定から選ぶ。
    fn fill_routing(&mut self, keep: Option<Routing>, window: &mut Window, cx: &mut App) {
        let Some((input, output)) = self
            .chosen(cx)
            .filter(|(input, _)| connect::shares_device(&input.host))
        else {
            self.input_pairs.clear();
            self.output_pairs.clear();
            self.channels = [0, 0];
            return;
        };
        let routing = keep.unwrap_or_else(|| connect::initial_routing(self.saved.as_ref(), &input));
        let independent = match routing.output {
            Output::Independent(pair) => Some(pair),
            _ => None,
        };
        self.channels = [input.channels, output.channels];
        self.input_pairs = connect::pairs(input.channels, routing.input);
        self.output_pairs = connect::pairs(output.channels, independent);
        let lang = self.lang;
        let pair_names = |pairs: &[[usize; 2]], key| {
            pairs
                .iter()
                .map(|[left, right]| {
                    SharedString::from(core_with(
                        lang,
                        key,
                        &[("left", &(left + 1)), ("right", &(right + 1))],
                    ))
                })
                .collect()
        };
        let input_row = routing
            .input
            .and_then(|pair| self.input_pairs.iter().position(|p| *p == pair));
        set(
            &self.input_pair,
            pair_names(&self.input_pairs, keys::CHANNEL_INPUT),
            input_row,
            window,
            cx,
        );
        let modes = OUTPUT_MODES
            .iter()
            .map(|(key, _)| SharedString::from(core(lang, key)))
            .collect();
        set(
            &self.output_mode,
            modes,
            Some(routing.output.row()),
            window,
            cx,
        );
        let output_row = independent
            .and_then(|pair| self.output_pairs.iter().position(|p| *p == pair))
            .or((!self.output_pairs.is_empty()).then_some(0));
        set(
            &self.output_pair,
            pair_names(&self.output_pairs, keys::ROUTING_PAIR),
            output_row,
            window,
            cx,
        );
    }

    /// 選んでいる割り当て。ASIO 以外は決まった割り当て（前に ASIO で選んだ番号を持ち越さない）。
    pub fn routing(&self, cx: &App) -> Routing {
        if !connect::shares_device(&self.host_name(cx)) {
            return connect::SYSTEM_ROUTING;
        }
        let row = |state: &Entity<Choices>| Some(state.read(cx).selected_index(cx)?.row);
        let pick = |state, pairs: &[[usize; 2]]| row(state).and_then(|r| pairs.get(r).copied());
        Routing {
            input: pick(&self.input_pair, &self.input_pairs),
            output: Output::from_row(
                row(&self.output_mode),
                pick(&self.output_pair, &self.output_pairs),
            ),
        }
    }

    /// 選んでいる周波数とバッファ。`None` は「自動」。
    pub fn values(&self, cx: &App) -> (Option<u32>, Option<u32>) {
        let value = |state: &Entity<Choices>, values: &[u32]| {
            connect::value_at(values, state.read(cx).selected_index(cx)?.row)
        };
        (
            value(&self.rate, &self.rates),
            value(&self.buffer, &self.buffers),
        )
    }

    fn host_name(&self, cx: &App) -> String {
        self.host
            .read(cx)
            .selected_value()
            .map(|v| v.to_string())
            .unwrap_or_default()
    }

    /// 選んでいるマイクと出力先。ASIO では、出力はマイクと同じドライバー。
    pub fn chosen(&self, cx: &App) -> Option<(Device, Device)> {
        let host = self.host_name(cx);
        let pick = |state: &Entity<Choices>, is_input: bool| {
            let label = state.read(cx).selected_value()?;
            connect::by_label(&self.devices, &host, is_input, label)
        };
        let input = pick(&self.input, true)?;
        let output = if connect::shares_device(&host) {
            connect::shared_output(&connect::of_host(&self.devices, &host, false), input)?
        } else {
            pick(&self.output, false)?
        };
        Some((input.clone(), output.clone()))
    }

    /// 開始のボタンは止まっているときだけ押せる（動いている機器を替える手順は、まだ無い）。
    /// `signal` は動いている ASIO の入力の信号を見ている間だけ渡す。
    pub fn render(
        &self,
        phase: Phase,
        lang: Lang,
        signal: Option<InputSignal>,
        cx: &App,
        actions: Actions,
    ) -> impl IntoElement {
        let Actions {
            on_start,
            on_apps,
            on_switch,
            on_use_pair,
        } = actions;
        let host = self.host_name(cx);
        let shared = connect::shares_device(&host);
        let app = self.uses_app(cx);
        let stopped = phase.can_start();
        let running = phase == Phase::Running;
        let unchosen = self.start_choice(cx).is_none();
        let empty = core(lang, keys::NO_DEVICES);
        div()
            .flex()
            .flex_col()
            .gap_4()
            .max_w(px(480.))
            .child(field(
                core(lang, keys::CONNECTION_METHOD),
                Select::new(&self.host).placeholder(empty),
            ))
            .child(field(core(lang, keys::SOURCE), Select::new(&self.source)))
            .when(shared, |this| {
                this.child(note(core(lang, keys::SOURCE_ASIO)))
            })
            .child(field(core(lang, keys::PURPOSE), Select::new(&self.purpose)))
            .when_some(self.other_usage(cx), |this, other| {
                let input = other
                    .app
                    .as_ref()
                    .map(|app| app.name.clone())
                    .or_else(|| other.input.clone())
                    .unwrap_or_default();
                let output = other.output.clone().unwrap_or_default();
                let name = core(lang, purpose_label(other.purpose));
                this.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap_2()
                        .child(div().flex_1().min_w(px(200.)).child(note(core_with(
                            lang,
                            keys::USAGE_SWITCH_DEVICES,
                            &[("input", &input), ("output", &output), ("name", &name)],
                        ))))
                        .child(
                            Button::new("connect-switch-purpose")
                                .label(core(lang, keys::USAGE_LOAD))
                                .outline()
                                .small()
                                .on_click(move |_, window, cx| on_switch(window, cx)),
                        ),
                )
            })
            .child(shift(
                ElementId::NamedInteger(
                    "connect-input".into(),
                    u64::from(app) * 2 + u64::from(shared),
                ),
                div().map(|this| {
                    if app {
                        this.child(self.render_app(lang, on_apps))
                    } else {
                        this.child(if shared {
                            field_hint(
                                lang,
                                core(lang, keys::DEVICE),
                                Some(keys::ASIO_SHARED),
                                Select::new(&self.input).placeholder(empty),
                            )
                        } else {
                            field(
                                core(lang, keys::MICROPHONE),
                                Select::new(&self.input).placeholder(empty),
                            )
                        })
                    }
                }),
            ))
            .when(!shared, |this| {
                this.child(field(
                    core(lang, keys::OUTPUT),
                    Select::new(&self.output).placeholder(empty),
                ))
            })
            .child(field_hint(
                lang,
                core(lang, keys::SAMPLE_RATE),
                connect::uses_system_rate(&host).then_some(keys::WASAPI_RATE),
                Select::new(&self.rate),
            ))
            .child(field(
                core(lang, keys::BUFFER_SIZE),
                Select::new(&self.buffer),
            ))
            .when(shared, |this| {
                this.child(shift(
                    "connect-routing".into(),
                    div().child(self.render_routing(lang, signal, on_use_pair, cx)),
                ))
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1p5()
                    .child(
                        Button::new("connect-start")
                            .label(core(
                                lang,
                                if running {
                                    keys::APPLY_RESTART
                                } else {
                                    keys::START
                                },
                            ))
                            .icon(if running {
                                IconName::RefreshCw
                            } else {
                                IconName::Play
                            })
                            .primary()
                            .disabled(!(stopped || running) || unchosen)
                            .on_click(move |_, window, cx| on_start(window, cx)),
                    )
                    .map(|this| {
                        if running {
                            this.child(note(core(lang, keys::RESTART_NOTE)))
                        } else if unchosen {
                            this.child(note(core(lang, keys::FIRST_START_HINT)))
                        } else {
                            this
                        }
                    }),
            )
    }
}

impl ConnectPage {
    /// アプリの音声：アプリと原音の出力先を選ぶ。一覧は「更新」で読む（音を出しているアプリだけが出る）。
    fn render_app(
        &self,
        lang: Lang,
        on_apps: impl Fn(&mut Window, &mut App) + 'static,
    ) -> impl IntoElement {
        let saved = self.saved.as_ref().and_then(|s| s.app.as_ref());
        let placeholder = match saved {
            Some(app) => core_with(lang, keys::APP_RESELECT, &[("name", &app.name)]),
            None => core(lang, keys::APP_CHOOSE).to_owned(),
        };
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(field_hint(
                lang,
                core(lang, keys::APP),
                Some(keys::APP_ROUTE_HELP),
                Select::new(&self.app).placeholder(placeholder),
            ))
            .child(with_hint(
                "connect-apps-hint",
                lang,
                core(lang, keys::APP_REFRESH_HELP),
                Button::new("connect-apps")
                    .label(core(lang, keys::APP_REFRESH))
                    .icon(IconName::RefreshCw)
                    .outline()
                    .small()
                    .on_click(move |_, window, cx| on_apps(window, cx)),
            ))
            .when_some(self.apps_failed.clone(), |this, error| {
                this.child(div().text_sm().text_color(color::warning()).child(error))
            })
            .child(field(
                core(lang, keys::APP_RAW),
                Select::new(&self.route).placeholder(core(lang, keys::APP_CHOOSE_RAW)),
            ))
    }

    /// ASIO の入力のペアと、出力の返し方。チャンネル数が分からなければ入力のペアは選ばせない（ホストに任せる）。
    fn render_routing(
        &self,
        lang: Lang,
        signal: Option<InputSignal>,
        on_use_pair: OnPair,
        cx: &App,
    ) -> impl IntoElement {
        let mode = self.output_mode.read(cx).selected_index(cx).map(|i| i.row);
        let hint = OUTPUT_MODES[mode.unwrap_or(Output::Legacy.row())].1;
        div()
            .flex()
            .flex_col()
            .gap_4()
            .when(self.channels[0] == 0, |this| {
                this.child(note(core(lang, keys::CHANNEL_UNVERIFIED)))
            })
            .when(!self.input_pairs.is_empty(), |this| {
                this.child(field(
                    core(lang, keys::CHANNEL_TITLE),
                    Select::new(&self.input_pair),
                ))
            })
            .when_some(signal, |this, signal| {
                this.child(render_signal(lang, signal, on_use_pair))
            })
            .child(field(
                core(lang, keys::ROUTING_MODE),
                Select::new(&self.output_mode),
            ))
            .child(note(core(lang, hint)))
            .when(mode == Some(0), |this| {
                this.child(field(
                    core(lang, keys::ROUTING_CHANNELS),
                    Select::new(&self.output_pair),
                ))
            })
            .when(self.channels[1] == 0 && mode == Some(0), |this| {
                this.child(note(core(lang, keys::ROUTING_UNVERIFIED)))
            })
    }
}

/// 画面の操作。`MainView` がエンジンへの命令にする。
pub struct Actions {
    pub on_start: OnClick,
    pub on_apps: OnClick,
    pub on_switch: OnClick,
    /// 動いている ASIO の入力のペアを替えて始め直す。
    pub on_use_pair: OnPair,
}

pub type OnClick = Box<dyn Fn(&mut Window, &mut App)>;
pub type OnPair = std::rc::Rc<dyn Fn([usize; 2], &mut Window, &mut App)>;

/// 動いている ASIO の入力の信号。
pub struct InputSignal<'a> {
    /// 動いている接続の入力のペア。
    pub current: [usize; 2],
    /// いま音が来ているチャンネル。`None` はまだ一度も届いていない。
    pub heard: Option<&'a [usize]>,
}

/// 動いている ASIO の入力のどこに音が来ているか。選んでいるペアが無音で、ほかに音が来ていれば切り替えを勧める。
fn render_signal(lang: Lang, signal: InputSignal, on_use_pair: OnPair) -> impl IntoElement {
    let InputSignal { current, heard } = signal;
    let pairs = channel_signal::heard_pairs(heard.unwrap_or_default());
    let status = if heard.is_none() {
        core(lang, keys::CHANNEL_WAITING).to_owned()
    } else if pairs.is_empty() {
        core(lang, keys::CHANNEL_SILENT).to_owned()
    } else {
        let names = pairs
            .iter()
            .map(|&pair| mix::pair_label(pair))
            .collect::<Vec<_>>()
            .join(", ");
        core_with(lang, keys::CHANNEL_HEARD, &[("pairs", &names)])
    };
    let suggestion = heard.and_then(|heard| channel_signal::suggestion(heard, current));
    div()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .text_sm()
                .text_color(if pairs.is_empty() {
                    color::muted()
                } else {
                    color::success()
                })
                .child(Icon::new(IconName::AudioLines))
                .child(status),
        )
        .when_some(suggestion, |this, pair| {
            this.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .text_sm()
                            .text_color(color::warning())
                            .child(core_with(
                                lang,
                                keys::CHANNEL_SUGGEST,
                                &[("current", &mix::pair_label(current))],
                            )),
                    )
                    .child(
                        Button::new("connect-use-pair")
                            .label(core_with(
                                lang,
                                keys::CHANNEL_USE,
                                &[("pair", &mix::pair_label(pair))],
                            ))
                            .icon(IconName::RefreshCw)
                            .small()
                            .on_click(move |_, window, cx| on_use_pair(pair, window, cx)),
                    )
                    .child(hint(
                        "connect-use-pair-hint",
                        lang,
                        core(lang, keys::CHANNEL_USE_HINT),
                    )),
            )
        })
}

fn set(
    state: &Entity<Choices>,
    names: Vec<SharedString>,
    selected: Option<usize>,
    window: &mut Window,
    cx: &mut App,
) {
    state.update(cx, |state, cx| {
        state.set_items(names, window, cx);
        state.set_selected_index(selected.map(IndexPath::new), window, cx);
    });
}

/// 先頭に「自動」を置き、`value` が候補にあればそれを、無ければ「自動」を選ぶ。
fn set_values(
    state: &Entity<Choices>,
    values: &[u32],
    value: Option<u32>,
    lang: Lang,
    label: impl Fn(u32) -> String,
    window: &mut Window,
    cx: &mut App,
) {
    let names = std::iter::once(SharedString::from(core(lang, keys::AUTO)))
        .chain(values.iter().map(|&v| SharedString::from(label(v))))
        .collect();
    let row = connect::row_of(values, value);
    set(state, names, Some(row), window, cx);
}

/// 48000 → "48 kHz"、44100 → "44.1 kHz"。
fn khz(rate: u32) -> String {
    let text = format!("{:.3}", f64::from(rate) / 1000.0);
    format!("{} kHz", text.trim_end_matches('0').trim_end_matches('.'))
}

fn purpose_label(purpose: Purpose) -> &'static str {
    match purpose {
        Purpose::Voice => keys::PURPOSE_VOICE,
        Purpose::Music => keys::PURPOSE_MUSIC,
    }
}

fn field(label: &'static str, select: Select<Vec<SharedString>>) -> Div {
    div()
        .flex()
        .flex_col()
        .gap_1p5()
        .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(label))
        .child(select.accessibility_label(label))
}

/// 項目名の後ろに ⓘ（`hint` が無ければ [`field`] と同じ）。
fn field_hint(
    lang: Lang,
    label: &'static str,
    hint: Option<&'static str>,
    select: Select<Vec<SharedString>>,
) -> Div {
    let Some(hint) = hint else {
        return field(label, select);
    };
    div()
        .flex()
        .flex_col()
        .gap_1p5()
        .child(
            with_hint(
                format!("{label}-hint"),
                lang,
                core(lang, hint),
                div().font_weight(FontWeight::MEDIUM).child(label),
            )
            .text_sm(),
        )
        .child(select.accessibility_label(label))
}
