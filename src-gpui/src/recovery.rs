//! ホームの「音声エンジンが停止しました」：落ちた理由と、始め直す方法を選ぶカード。
//! 判断は `auralyn-ui-model` の `recovery`。どの方法でも、保存した VST の並びは消さない。

use std::rc::Rc;

use auralyn_ui_model::recovery::{Choice, Exit, Summary, VstOp};
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::Disableable as _;
use gpui_kit::*;

use crate::color;
use crate::i18n::{core, core_with, keys, Lang};
use crate::part::{card, note};

/// `stopped` でなければ（始め直している途中など）ボタンを押せない。
pub fn render(
    exit: &Exit,
    lang: Lang,
    stopped: bool,
    on_choice: impl Fn(Choice, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let on_choice = Rc::new(on_choice);
    let suspect = exit.suspect();
    let choices = exit.choices();
    let buttons = choices.into_iter().enumerate().map(|(index, choice)| {
        let on_choice = on_choice.clone();
        let button = Button::new(SharedString::from(format!("recovery-{index}")))
            .label(core(lang, label(&choice, exit.is_device())))
            .disabled(!stopped);
        let button = if index == 0 {
            button.primary()
        } else {
            button.outline()
        };
        button.on_click(move |_, window, cx| on_choice(choice.clone(), window, cx))
    });
    card(
        core(lang, keys::RECOVERY_TITLE),
        div(),
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_color(color::warning())
                    .child(summary(exit, lang)),
            )
            .child(note(core(
                lang,
                if exit.is_device() {
                    keys::RECOVERY_DEVICE_DESCRIPTION
                } else {
                    keys::RECOVERY_DESCRIPTION
                },
            )))
            .children(suspect.map(|suspect| {
                note(format!(
                    "{} {}",
                    core(lang, keys::RECOVERY_PENDING),
                    suspect.path
                ))
            }))
            .child(div().flex().flex_wrap().gap_2().children(buttons))
            .child(note(core(lang, keys::RECOVERY_SAFETY))),
    )
    .icon(IconName::TriangleAlert)
}

fn label(choice: &Choice, device: bool) -> &'static str {
    match choice {
        Choice::Exclude(_) => keys::RECOVERY_EXCLUDE,
        Choice::Reload => keys::RECOVERY_RELOAD,
        Choice::Empty => keys::RECOVERY_EMPTY,
        Choice::KeepStopped if device => keys::RECOVERY_DEVICE_STOP,
        Choice::KeepStopped => keys::RECOVERY_STOP,
        Choice::ChooseDevice => keys::RECOVERY_CHOOSE_DEVICE,
    }
}

/// 落ちた理由の一文。
fn summary(exit: &Exit, lang: Lang) -> String {
    let named =
        |name: Option<String>, fallback| name.unwrap_or_else(|| core(lang, fallback).to_owned());
    match exit.summary() {
        Summary::DeviceOpening(name) => core_with(
            lang,
            keys::EXITED_DEVICE_OPENING,
            &[("name", &named(name, keys::EXITED_DEVICE_FALLBACK))],
        ),
        Summary::DeviceSettling(name) => core_with(
            lang,
            keys::EXITED_DEVICE_SETTLING,
            &[("name", &named(name, keys::EXITED_DEVICE_FALLBACK))],
        ),
        Summary::Vst { name, op } => core_with(
            lang,
            keys::EXITED_VST,
            &[
                ("name", &named(name, keys::EXITED_VST_FALLBACK)),
                ("operation", &core(lang, op_key(op))),
            ],
        ),
        Summary::Unknown => core(lang, keys::EXITED_UNKNOWN).to_owned(),
    }
}

fn op_key(op: VstOp) -> &'static str {
    match op {
        VstOp::Load => keys::VST_OP_LOAD,
        VstOp::Restore => keys::VST_OP_RESTORE,
        VstOp::SetState => keys::VST_OP_SET_STATE,
        VstOp::GetState => keys::VST_OP_GET_STATE,
        VstOp::OpenEditor => keys::VST_OP_OPEN_EDITOR,
        VstOp::Remove => keys::VST_OP_REMOVE,
        VstOp::Resume => keys::VST_OP_RESUME,
        VstOp::ProcessingSetup => keys::VST_OP_PROCESSING_SETUP,
        VstOp::Other => keys::VST_OP_OTHER,
    }
}
