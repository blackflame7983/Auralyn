//! OBS との接続を、画面とは別のスレッドで扱う。接続は Tauri 版と同じ `vst_host_lib::obs`（obws と tokio）を使い、
//! パスワードは同じ `obs-credentials.dpapi`（Windows のユーザー単位で保護）へ保存する。
//!
//! 命令は1本のスレッドが受付順に実行する（接続と切断が入れ替わらない）。到達確認の間（最大十数秒）は、
//! 切断もその後に待つ（Tauri 版のように途中で中止はしない。テスト音は確認の終わりに必ず止める）。OBS 側から切れたら `Reply::Lost` を送る
//! （自分で切断したときは送らない）。

use std::path::{Path, PathBuf};

use auralyn_ui_model::obs::{Reach, Reached, Request, Target, REACH_MS};
use vst_host_lib::obs::{self, ObsState, ReachReceipt, ReachTone, ReachValue};

use crate::engine::{Command, ToneStep};
use vst_host_lib::obs_credentials::{self, Endpoint};

/// パスワードを含むので Debug は付けない（ログへ出さない）。
#[derive(Clone)]
pub enum Order {
    /// 接続しているかと、保存した接続先を読む。
    Read,
    Connect(Request),
    Disconnect,
    /// 保存したパスワードを消す。
    Forget,
    /// テスト音を鳴らし、OBS の「Auralyn マイク」のメーターで届くかを確かめる。
    CheckReach,
    /// 前の確認がまだ今の条件のものかを聞く（番号は `Reach::operation`）。
    ReachCurrent(String),
}

#[derive(Debug, Clone)]
pub enum Reply {
    /// `saved` は保存した接続先。`Err` は保存したものを読めない（消して入れ直してもらう）。
    /// `after_connect` は接続の命令の結果か。
    State {
        connected: bool,
        saved: Result<Option<Target>, String>,
        after_connect: bool,
    },
    /// 命令が失敗した。状態はこのあとの `State` で届く。
    Failed {
        connect: bool,
        message: String,
    },
    /// OBS 側から接続が切れた（OBS を閉じたときなど）。
    Lost,
    Reach(Result<Reach, String>),
    ReachCurrent {
        operation: String,
        current: bool,
    },
    /// OBS を扱うスレッドを動かせない。以後の命令には返事が来ない。
    Unavailable(String),
}

pub struct ObsLink {
    orders: flume::Sender<Order>,
    pub replies: flume::Receiver<Reply>,
}

impl ObsLink {
    /// `engine` はテスト音を鳴らすときの、音声エンジンへの命令の口。
    pub fn start(config_dir: &Path, engine: flume::WeakSender<Command>) -> Self {
        let (orders, inbox) = flume::unbounded();
        let (outbox, replies) = flume::unbounded();
        let file = obs_credentials::file_in(config_dir);
        let failed = outbox.clone();
        let spawned = std::thread::Builder::new()
            .name("obs".into())
            .spawn(move || run(file, EngineTone(engine), inbox, outbox));
        if let Err(error) = spawned {
            let _ = failed.send(Reply::Unavailable(error.to_string()));
        }
        Self { orders, replies }
    }

    pub fn send(&self, order: Order) {
        let _ = self.orders.send(order);
    }
}

fn run(
    file: PathBuf,
    tone: EngineTone,
    inbox: flume::Receiver<Order>,
    outbox: flume::Sender<Reply>,
) {
    // obws の受信を続けるため、命令を待つ間も動く作業スレッドを1本持つ。
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = outbox.send(Reply::Unavailable(error.to_string()));
            return;
        }
    };
    runtime.block_on(async move {
        let state = ObsState::new();
        while let Ok(order) = inbox.recv_async().await {
            let connect_order = matches!(order, Order::Connect(_));
            let result = match order {
                Order::CheckReach => {
                    let reach = obs::check_audio_reach(&state, tone.clone(), REACH_MS)
                        .await
                        .map(|result| {
                            let reached = match result.reached {
                                ReachValue::Bool(true) => Reached::Yes,
                                ReachValue::Bool(false) => Reached::No,
                                ReachValue::Str(_) => Reached::Unsupported,
                            };
                            let operation = result
                                .verification
                                .as_ref()
                                .map(|v| v.operation_id().to_string());
                            Reach::new(reached, result.peak_db, operation)
                        });
                    let _ = outbox.send(Reply::Reach(reach));
                    continue;
                }
                Order::ReachCurrent(operation) => {
                    let current = obs::audio_reach_current(&state, &operation).await;
                    let _ = outbox.send(Reply::ReachCurrent { operation, current });
                    continue;
                }
                Order::Read => Ok(()),
                Order::Connect(request) => connect(&file, &state, request, &outbox).await,
                Order::Disconnect => obs::disconnect_obs(notify(&outbox), &state).await,
                Order::Forget => obs_credentials::forget(&file),
            };
            if let Err(message) = result {
                let _ = outbox.send(Reply::Failed {
                    connect: connect_order,
                    message,
                });
            }
            let _ = outbox.send(Reply::State {
                connected: obs::connection_status(&state).await,
                saved: obs_credentials::saved_endpoint(&file).map(|saved| {
                    saved.map(|endpoint| Target {
                        host: endpoint.host,
                        port: endpoint.port,
                    })
                }),
                after_connect: connect_order,
            });
        }
        let _ = obs::disconnect_obs(notify(&outbox), &state).await;
    });
}

/// Tauri 版の `connect_obs` と同じ：パスワードが無ければ保存したものを使い、つながったら保存する。保存できなければ切る。
async fn connect(
    file: &Path,
    state: &ObsState,
    request: Request,
    outbox: &flume::Sender<Reply>,
) -> Result<(), String> {
    let endpoint = Endpoint::new(request.target.host, request.target.port)?;
    let password = obs_credentials::password_for(file, endpoint.clone(), request.password)?;
    obs::connect_obs(
        notify(outbox),
        state,
        endpoint.host.clone(),
        endpoint.port,
        password.clone(),
    )
    .await?;
    if let Err(error) = obs_credentials::store(file, endpoint, password.unwrap_or_default()) {
        let _ = obs::disconnect_obs(notify(outbox), state).await;
        return Err(error);
    }
    Ok(())
}

fn notify(outbox: &flume::Sender<Reply>) -> impl obs::Notify {
    let outbox = outbox.clone();
    move |name, _| {
        if name == "obs://live-scene-invalidated" {
            let _ = outbox.send(Reply::Lost);
        }
    }
}

/// テスト音は、音声エンジンのスレッドに鳴らしてもらう（`AudioHost` はそのスレッドだけが持つ）。
/// 弱い口にして、画面が閉じたらエンジンのスレッドが終われるようにする。
#[derive(Clone)]
struct EngineTone(flume::WeakSender<Command>);

impl EngineTone {
    async fn ask(&self, step: ToneStep) -> Result<ReachReceipt, String> {
        let (reply, answer) = flume::bounded(1);
        self.0
            .upgrade()
            .ok_or("音声エンジンが終わっています")?
            .send(Command::ReachTone(step, reply))
            .map_err(|_| "音声エンジンに届きません".to_string())?;
        answer
            .recv_async()
            .await
            .map_err(|_| "音声エンジンが応えません".to_string())?
    }
}

impl ReachTone for EngineTone {
    async fn play(&self, duration_ms: u32) -> Result<ReachReceipt, String> {
        self.ask(ToneStep::Play(duration_ms)).await
    }

    async fn stop(&self, receipt: &ReachReceipt) -> Result<ReachReceipt, String> {
        self.ask(ToneStep::Stop(Box::new(receipt.clone()))).await
    }
}
