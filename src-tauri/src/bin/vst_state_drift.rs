//! 配布に含めない、操作なしのVST状態変化の検証用CLI。
#![warn(clippy::undocumented_unsafe_blocks)]

use anyhow::{anyhow, bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::path::Path;
use std::process::ExitCode;
use std::time::Instant;
use vst_host_lib::vst_host::instance::ClassLoadPolicy;
use vst_host_lib::vst_host::scanner::resolve_binary;
use vst_host_lib::vst_host::state_drift::{
    measure_drift, DriftConfig, DriftReport, DriftTarget, DriftVerdict,
};
use vst_host_lib::vst_host::{VstInstance, VstProcessor};

const HELP: &str = "VST状態変化の確認（開発用・配布対象外）
使い方：vst_state_drift --plugin <.vst3のパス> [オプション]
  --class <CID>        カタログの対象クラスを選ぶ（省略時は既定クラス）
  --seconds <秒>       計測の長さ（正の整数、既定60）
  --interval <秒>      状態の取得間隔（正の整数、既定5）
  --rate <Hz>          サンプルレート（正の整数、既定48000）
  --block <frame>      blockの大きさ（正の整数、既定512）
  --channels <数>      チャネル数（1または2、既定2）
  --signal <種類>     silence（既定）|noise（固定種、約-20 dBFS RMS）|sine（1 kHz、-18 dBFS peak）
  --fast              実時間で待たずに処理する
  --json              JSONで報告する（診断ログはstderr）
  --help, -h          この説明を表示する

処理前に状態を2回取得し、その後は音声処理と状態取得を同じスレッドで交互に行います。
アプリは別スレッドで並行するため、この道具とは結果が異なる場合があります。
実時間依存・乱数を使うVSTでは、--fastや再実行によっても結果が異なります。
状態取得は指定間隔を越えた最初のblock末尾と計測終了時に行います。
音声デバイスやエディターは開かず、生成した信号をVSTへ渡します。出力音声は破棄します。
終了コード：0＝変化なし、2＝変化あり、1＝エラー。";

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum Signal {
    Silence,
    Noise,
    Sine,
}

#[derive(Debug)]
struct Options {
    plugin: String,
    class: Option<String>,
    config: DriftConfig,
    channels: usize,
    signal: Signal,
    json: bool,
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Options> {
    let mut options = Options {
        plugin: String::new(),
        class: None,
        config: DriftConfig::default(),
        channels: 2,
        signal: Signal::Silence,
        json: false,
    };
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == "--fast" {
            options.config.realtime = false;
            continue;
        }
        if arg == "--json" {
            options.json = true;
            continue;
        }
        ensure!(
            matches!(
                arg.as_str(),
                "--plugin"
                    | "--class"
                    | "--seconds"
                    | "--interval"
                    | "--rate"
                    | "--block"
                    | "--channels"
                    | "--signal"
            ),
            "不明な引数：{arg}（--helpを参照）"
        );
        let value = args
            .next()
            .filter(|value| !value.starts_with("--"))
            .ok_or_else(|| anyhow!("{arg}の値がありません"))?;
        match arg.as_str() {
            "--plugin" => options.plugin = value,
            "--class" => options.class = Some(value),
            "--seconds" => {
                options.config.seconds = value
                    .parse()
                    .context("secondsは正の整数で指定してください")?
            }
            "--interval" => {
                options.config.interval_seconds = value
                    .parse()
                    .context("intervalは正の整数で指定してください")?
            }
            "--rate" => {
                options.config.sample_rate =
                    value.parse().context("rateは正の整数で指定してください")?
            }
            "--block" => {
                options.config.block_size =
                    value.parse().context("blockは正の整数で指定してください")?
            }
            "--channels" => {
                options.channels = value
                    .parse()
                    .context("channelsは1または2で指定してください")?
            }
            "--signal" => {
                options.signal = match value.as_str() {
                    "silence" => Signal::Silence,
                    "noise" => Signal::Noise,
                    "sine" => Signal::Sine,
                    _ => bail!("signalはsilence、noise、sineから選んでください"),
                }
            }
            _ => unreachable!("認識済みの引数だけを処理する"),
        }
    }
    ensure!(
        !options.plugin.is_empty(),
        "--plugin <.vst3のパス>が必要です"
    );
    ensure!(
        matches!(options.channels, 1 | 2),
        "channelsは1または2で指定してください"
    );
    options.config.validate()?;
    Ok(options)
}

struct SignalGenerator {
    kind: Signal,
    seed: u32,
    phase: f64,
    rate: u32,
}

impl SignalGenerator {
    fn new(kind: Signal, rate: u32) -> Self {
        Self {
            kind,
            seed: 0x465_2026,
            phase: 0.0,
            rate,
        }
    }

    fn fill(&mut self, channels: &mut [Vec<f32>]) {
        for frame in 0..channels[0].len() {
            let sample = match self.kind {
                Signal::Silence => 0.0,
                Signal::Noise => {
                    // 固定種のxorshift32。一様分布のRMSが約0.1になる振幅。
                    self.seed ^= self.seed << 13;
                    self.seed ^= self.seed >> 17;
                    self.seed ^= self.seed << 5;
                    ((f64::from(self.seed) / f64::from(u32::MAX)) * 2.0 - 1.0)
                        * 0.1
                        * 3.0_f64.sqrt()
                }
                Signal::Sine => {
                    let sample = self.phase.sin() * 10.0_f64.powf(-18.0 / 20.0);
                    self.phase = (self.phase
                        + std::f64::consts::TAU * 1000.0 / f64::from(self.rate))
                        % std::f64::consts::TAU;
                    sample
                }
            } as f32;
            for channel in channels.iter_mut() {
                channel[frame] = sample;
            }
        }
    }
}

struct PluginTarget<'a> {
    instance: &'a mut VstInstance,
    processor: Option<VstProcessor>,
    input: Vec<Vec<f32>>,
    output: Vec<Vec<f32>>,
    signal: SignalGenerator,
    block: usize,
}

impl DriftTarget for PluginTarget<'_> {
    fn process_block(&mut self) -> Result<()> {
        self.signal.fill(&mut self.input);
        let processed = self
            .processor
            .as_mut()
            .context("processorがありません")?
            .process_planar_checked(&self.input, &mut self.output, self.block);
        ensure!(
            processed,
            "VSTが音声処理を拒否したか、処理用バッファが無効です"
        );
        Ok(())
    }

    fn read_state(&mut self) -> Result<Vec<u8>> {
        STANDARD
            .decode(self.instance.get_state()?)
            .context("状態のBase64復号に失敗しました")
    }
}

impl Drop for PluginTarget<'_> {
    fn drop(&mut self) {
        // 処理呼出しを終え、processorの参照を回収してから停止する。
        drop(self.processor.take());
        self.instance.stop_processing();
    }
}

/// sidecarと同じSTA/OLE・GDI+の前提をメインスレッドで用意する。
struct PluginEnvironment {
    gdiplus_token: usize,
}

impl PluginEnvironment {
    fn initialize() -> Result<Self> {
        use windows::Win32::{
            Graphics::GdiPlus::{
                GdiplusShutdown, GdiplusStartup, GdiplusStartupInput, GdiplusStartupOutput,
            },
            System::{
                Diagnostics::Debug::{
                    SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX,
                    SEM_NOOPENFILEERRORBOX,
                },
                Ole::{OleInitialize, OleUninitialize},
            },
            UI::HiDpi::{
                SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            },
        };
        // SAFETY: メインスレッドで、予約引数はNone。初期化成功分を同じスレッドで解放する。
        unsafe {
            SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            OleInitialize(None).context("OLEのSTA初期化に失敗しました")?;
            let mut token = 0;
            let input = GdiplusStartupInput {
                GdiplusVersion: 1,
                ..Default::default()
            };
            let mut output = GdiplusStartupOutput::default();
            let status = GdiplusStartup(&mut token, &input, &mut output);
            if status != windows::Win32::Graphics::GdiPlus::Ok {
                if token != 0 {
                    GdiplusShutdown(token);
                }
                OleUninitialize();
                bail!("GDI+の初期化に失敗しました：{status:?}");
            }
            Ok(Self {
                gdiplus_token: token,
            })
        }
    }
}

impl Drop for PluginEnvironment {
    fn drop(&mut self) {
        // SAFETY: プラグインをすべて解放した後、初期化したメインスレッドで一度だけ解放する。
        unsafe {
            windows::Win32::Graphics::GdiPlus::GdiplusShutdown(self.gdiplus_token);
            windows::Win32::System::Ole::OleUninitialize();
        }
    }
}

#[derive(Serialize)]
struct Output<'a> {
    plugin: &'a str,
    name: String,
    class: String,
    channels: usize,
    signal: Signal,
    report: DriftReport,
}

fn number(value: Option<usize>) -> String {
    value.map_or_else(|| "不明・比較なし".into(), |value| value.to_string())
}

fn yes_no(value: Option<bool>) -> &'static str {
    match value {
        Some(true) => "はい",
        Some(false) => "いいえ",
        None => "比較なし",
    }
}

fn run(options: Options) -> Result<u8> {
    // 宣言の逆順で解放し、DLL解放までOLEとGDI+を保持する。
    let _environment = PluginEnvironment::initialize()?;
    // バンドル形式（フォルダー）は、アプリのスキャンと同じ規則で中の実体を読む。
    let binary = resolve_binary(Path::new(&options.plugin))
        .with_context(|| format!("VST3の実体が見つかりません：{}", options.plugin))?;
    let mut instance = VstInstance::load_with_class(
        &binary.to_string_lossy(),
        options.class.as_deref(),
        ClassLoadPolicy::Catalog,
    )?;
    instance.negotiate_bus_layout(options.channels as i32)?;
    if instance.needs_deferred_connection() {
        instance.finalize_connection()?;
    }
    instance.prepare_processing(
        f64::from(options.config.sample_rate),
        options.config.block_size as i32,
        options.channels as i32,
    )?;
    let processor = instance
        .create_processor()
        .context("processorを作成できませんでした")?;
    let name = instance.name.clone();
    let class = instance.class_id.clone();
    let block = options.config.block_size as usize;
    let mut target = PluginTarget {
        instance: &mut instance,
        processor: Some(processor),
        input: vec![vec![0.0; block]; options.channels],
        output: vec![vec![0.0; block]; options.channels],
        signal: SignalGenerator::new(options.signal, options.config.sample_rate),
        block,
    };
    let started = Instant::now();
    let report = measure_drift(&mut target, options.config, |deadline| {
        std::thread::sleep(deadline.saturating_sub(started.elapsed()));
    })?;
    drop(target);
    drop(instance);
    let code = match report.verdict {
        None => 1,
        Some(DriftVerdict::Stable) => 0,
        Some(_) => 2,
    };
    let output = Output {
        plugin: &options.plugin,
        name,
        class,
        channels: options.channels,
        signal: options.signal,
        report,
    };
    if options.json {
        println!("{}", serde_json::to_string_pretty(&output)?);
    } else {
        println!(
            "VST：{}\n条件：{:?}、{} Hz、{} frame、{} ch、{}",
            output.name,
            options.signal,
            options.config.sample_rate,
            block,
            options.channels,
            if options.config.realtime {
                "実時間"
            } else {
                "fast"
            }
        );
        println!(
            "最初の状態：{} byte／連続2回の一致：{}",
            number(output.report.initial_size),
            yes_no(output.report.initial_reads_equal)
        );
        for sample in &output.report.samples {
            let difference = match (sample.different_bytes, sample.first_different_byte) {
                (None, _) => "比較なし".to_string(),
                (Some(0), _) => "変化なし".to_string(),
                (Some(count), Some(first)) => format!("{count} byte（最初の位置：{first}）"),
                (Some(count), None) => format!("{count} byte"),
            };
            println!(
                "{} ms：{} byte、直前との差分：{}、初期状態から変化：{}",
                sample.elapsed_ms,
                number(sample.size),
                difference,
                yes_no(sample.changed_from_initial)
            );
        }
        println!(
            "判定：{}\n{}",
            output
                .report
                .verdict
                .map_or_else(|| "判定不能".into(), |verdict| format!("{verdict:?}")),
            output.report.explanation
        );
        if let Some(error) = &output.report.error {
            println!("エラー：{error}");
        }
    }
    Ok(code)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{HELP}");
        return ExitCode::SUCCESS;
    }
    let json = args.iter().any(|arg| arg == "--json");
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"))
        .target(env_logger::Target::Stderr)
        .init();
    match parse_args(args).and_then(run) {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            if json {
                println!("{}", serde_json::json!({ "error": format!("{error:#}") }));
            } else {
                eprintln!("エラー：{error:#}");
            }
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Options> {
        parse_args(args.iter().map(|arg| (*arg).into()))
    }

    #[test]
    fn defaults_and_invalid_arguments() {
        let options = parse(&["--plugin", "test.vst3"]).unwrap();
        assert_eq!(options.config.seconds, 60);
        assert_eq!(options.config.interval_seconds, 5);
        assert_eq!(options.config.sample_rate, 48000);
        assert_eq!(options.config.block_size, 512);
        assert_eq!(options.channels, 2);
        for args in [
            vec![],
            vec!["--plugin"],
            vec!["--plugin", "test.vst3", "--seconds", "0"],
            vec!["--plugin", "test.vst3", "--rate", "NaN"],
            vec!["--plugin", "test.vst3", "--channels", "3"],
            vec!["--plugin", "test.vst3", "--signal", "bad"],
            vec!["--plugin", "test.vst3", "--unknown"],
        ] {
            assert!(parse(&args).is_err(), "{args:?}");
        }
        let options = parse(&[
            "--plugin",
            "test.vst3",
            "--class",
            "CID",
            "--fast",
            "--json",
            "--signal",
            "noise",
        ])
        .unwrap();
        assert!(!options.config.realtime);
        assert!(options.json);
        assert_eq!(options.class.as_deref(), Some("CID"));
    }

    #[test]
    fn signals_are_reproducible_at_specified_levels() {
        for signal in [Signal::Silence, Signal::Noise, Signal::Sine] {
            let mut first = vec![vec![0.0; 48000]; 2];
            let mut second = first.clone();
            SignalGenerator::new(signal, 48000).fill(&mut first);
            SignalGenerator::new(signal, 48000).fill(&mut second);
            assert_eq!(first, second);
            assert_eq!(first[0], first[1]);
            let rms = (first[0]
                .iter()
                .map(|sample| f64::from(*sample).powi(2))
                .sum::<f64>()
                / 48000.0)
                .sqrt();
            let expected = match signal {
                Signal::Silence => 0.0,
                Signal::Noise => 0.1,
                Signal::Sine => 10.0_f64.powf(-18.0 / 20.0) / 2.0_f64.sqrt(),
            };
            assert!((rms - expected).abs() < 0.001, "{signal:?}：{rms}");
        }
    }
}
