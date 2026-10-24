use crate::ipc::{DeviceInfo, DeviceScanStatus};
use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait};
use log;
use std::collections::HashMap;
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::thread::JoinHandle;
use std::time::Duration;

struct ScanJob {
    token: u64,
    cancelled: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    result: mpsc::Receiver<Result<Vec<DeviceInfo>, String>>,
    terminal: Option<DeviceScanStatus>,
}

pub struct DeviceManager {
    pub cached_devices: Vec<DeviceInfo>,
    has_cache: bool,
    next_scan_token: u64,
    scan: Option<ScanJob>,
    /// Currently active input device (set when audio starts)
    pub active_input: Option<DeviceInfo>,
    /// Currently active output device (set when audio starts)
    pub active_output: Option<DeviceInfo>,
}

impl Default for DeviceManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DeviceManager {
    /// ASIOは同じIDの出力Deviceをcloneし、CPAL内部の共有stream状態も揃える。
    /// WASAPIは独立した入出力Deviceを維持し、ID問い合わせも増やさない。
    pub(super) fn coordinated_pair<D: Clone, Id: Eq>(
        input: D,
        output: D,
        asio: bool,
        identity: impl Fn(&D) -> Result<Id>,
    ) -> Result<(D, D)> {
        if !asio {
            return Ok((input, output));
        }
        let input_id = identity(&input).context("ASIO入力DeviceのIDを確認できません")?;
        let output_id = identity(&output).context("ASIO出力DeviceのIDを確認できません")?;
        anyhow::ensure!(
            input_id == output_id,
            "ASIOの入出力は同じDeviceを選択してください"
        );
        drop(input);
        Ok((output.clone(), output))
    }

    pub fn new() -> Self {
        Self {
            cached_devices: Vec::new(),
            has_cache: false,
            next_scan_token: 0,
            scan: None,
            active_input: None,
            active_output: None,
        }
    }

    /// Set the currently active input device info (called when audio starts)
    pub fn set_active_input(&mut self, info: DeviceInfo) {
        log::debug!("Setting active input device: {} ({})", info.name, info.host);
        self.active_input = Some(info);
    }

    /// Set the currently active output device info (called when audio starts)
    pub fn set_active_output(&mut self, info: DeviceInfo) {
        log::debug!(
            "Setting active output device: {} ({})",
            info.name,
            info.host
        );
        self.active_output = Some(info);
    }

    /// Clear active device info (called when audio stops)
    pub fn clear_active_devices(&mut self) {
        self.active_input = None;
        self.active_output = None;
    }

    /// 旧GetDevicesはキャッシュ専用。制御loopでscannerを待たない。
    pub fn enumerate(&mut self) -> Result<Vec<DeviceInfo>> {
        anyhow::ensure!(
            self.has_cache,
            "デバイス一覧を再検出してください（BeginDeviceScan）"
        );
        Ok(self.cached_devices.clone())
    }

    pub fn begin_scan(&mut self) -> Result<u64> {
        let exe = std::env::current_exe().context("scanner executable unavailable")?;
        self.begin_scan_with(move |cancelled| {
            let output = crate::child_process::run_cancellable(
                Command::new(exe).arg("--scan"),
                Duration::from_secs(30),
                &cancelled,
            )
            .context("Device scanner did not complete")?;
            anyhow::ensure!(
                output.status.success(),
                "Device scanner exited unsuccessfully"
            );
            serde_json::from_slice(&output.stdout).context("Device scanner returned invalid JSON")
        })
    }

    fn begin_scan_with(
        &mut self,
        scan: impl FnOnce(Arc<AtomicBool>) -> Result<Vec<DeviceInfo>> + Send + 'static,
    ) -> Result<u64> {
        if let Some(job) = &self.scan {
            anyhow::ensure!(
                job.worker.as_ref().is_none_or(JoinHandle::is_finished),
                "デバイスを検出中です。完了または取消後に再試行してください"
            );
        }
        // is_finished確認後だけjoinする。生存workerを制御loopで待たない。
        if let Some(mut previous) = self.scan.take() {
            if let Some(worker) = previous.worker.take() {
                let _ = worker.join();
            }
        }
        let token = self
            .next_scan_token
            .checked_add(1)
            .ok_or_else(|| anyhow!("scan token exhausted"))?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = cancelled.clone();
        let (sender, result) = mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("device-scanner".into())
            .spawn(move || {
                let result = scan(worker_cancelled).map_err(|error| error.to_string());
                let _ = sender.send(result);
            })?;
        self.next_scan_token = token;
        self.scan = Some(ScanJob {
            token,
            cancelled,
            worker: Some(worker),
            result,
            terminal: None,
        });
        Ok(token)
    }

    pub fn poll_scan(&mut self, token: u64) -> Result<DeviceScanStatus> {
        let job = self
            .scan
            .as_mut()
            .filter(|job| job.token == token)
            .ok_or_else(|| anyhow!("デバイス検出要求は失効しています"))?;
        if let Some(status) = &job.terminal {
            return Ok(status.clone());
        }
        if job
            .worker
            .as_ref()
            .is_some_and(|worker| !worker.is_finished())
        {
            return Ok(DeviceScanStatus::Pending);
        }
        if let Some(worker) = job.worker.take() {
            let _ = worker.join();
        }
        let status = if job.cancelled.load(Ordering::Acquire) {
            DeviceScanStatus::Cancelled
        } else {
            match job.result.try_recv() {
                Ok(Ok(mut devices)) => {
                    // 結果取得時の稼働情報だけを補完する。開始時の古い経路を残さない。
                    for active in [&self.active_input, &self.active_output]
                        .into_iter()
                        .flatten()
                    {
                        if !devices.iter().any(|device| {
                            device.name == active.name
                                && device.host == active.host
                                && device.is_input == active.is_input
                        }) {
                            devices.push(active.clone());
                        }
                    }
                    self.cached_devices = devices.clone();
                    self.has_cache = true;
                    DeviceScanStatus::Completed(devices)
                }
                Ok(Err(error)) => DeviceScanStatus::Failed(error),
                Err(_) => {
                    DeviceScanStatus::Failed("デバイス検出workerが結果を返さず終了しました".into())
                }
            }
        };
        job.terminal = Some(status.clone());
        Ok(status)
    }

    pub fn cancel_scan(&mut self, token: u64) -> Result<()> {
        let job = self
            .scan
            .as_mut()
            .filter(|job| job.token == token)
            .ok_or_else(|| anyhow!("デバイス検出要求は失効しています"))?;
        job.cancelled.store(true, Ordering::Release);
        // 成功結果を取得済みならそのcacheは保持する。未取得結果は適用しない。
        if job.terminal.is_none() && job.worker.as_ref().is_none_or(JoinHandle::is_finished) {
            job.terminal = Some(DeviceScanStatus::Cancelled);
        }
        Ok(())
    }

    #[allow(deprecated)]
    pub fn resolve_input_device(host: &cpal::Host, target_name: &str) -> Option<cpal::Device> {
        if host.id() == cpal::HostId::Asio {
            return resolve_asio_device(
                || {
                    Some(
                        host.input_devices()
                            .ok()?
                            .filter_map(|device| device.name().ok().map(|name| (device, name))),
                    )
                },
                target_name,
            );
        }
        let devices = host.input_devices().ok()?;
        resolve_named_device(
            devices.filter_map(|device| device.name().ok().map(|name| (device, name))),
            target_name,
        )
    }

    #[allow(deprecated)]
    pub fn resolve_output_device(host: &cpal::Host, target_name: &str) -> Option<cpal::Device> {
        if host.id() == cpal::HostId::Asio {
            return resolve_asio_device(
                || {
                    Some(
                        host.output_devices()
                            .ok()?
                            .filter_map(|device| device.name().ok().map(|name| (device, name))),
                    )
                },
                target_name,
            );
        }
        let devices = host.output_devices().ok()?;
        resolve_named_device(
            devices.filter_map(|device| device.name().ok().map(|name| (device, name))),
            target_name,
        )
    }
}

// ASIOは同時に異なるdriverを保持できない。完全一致を先に探し、
// 非選択Deviceは次のnextより前に破棄する。registryのdriver名は一意。
fn resolve_asio_device<T, I>(mut devices: impl FnMut() -> Option<I>, target: &str) -> Option<T>
where
    I: Iterator<Item = (T, String)>,
{
    for (device, name) in devices()? {
        if name == target {
            return Some(device);
        }
    }
    // 表示用レートだけを除いて再列挙する。候補Deviceを保持したまま
    // 別driverを探さず、実在する完全一致名より接尾辞除去を優先しない。
    let base = asio_name_without_rate_suffix(target)?;
    for (device, name) in devices()? {
        if name == base {
            return Some(device);
        }
    }
    None
}

fn asio_name_without_rate_suffix(target: &str) -> Option<&str> {
    let (base, suffix) = target.rsplit_once(" [")?;
    let rates = suffix.strip_suffix("kHz]")?;
    if base.is_empty()
        || !rates.split(['/', ',']).all(|rate| {
            let rate = rate.trim().strip_suffix("kHz").unwrap_or(rate.trim());
            !rate.is_empty()
                && rate.chars().all(|ch| ch.is_ascii_digit() || ch == '.')
                && rate
                    .parse::<f64>()
                    .is_ok_and(|rate| rate.is_finite() && rate > 0.0)
        })
    {
        return None;
    }
    Some(base)
}

// Engine終了時だけ、取消したworkerが子とpipeを回収するまで待つ。
// 通常のBegin/Poll/Cancelや音声停止からは呼ばない。
impl Drop for DeviceManager {
    fn drop(&mut self) {
        if let Some(job) = &mut self.scan {
            job.cancelled.store(true, Ordering::Release);
            if let Some(worker) = job.worker.take() {
                let _ = worker.join();
            }
        }
    }
}

// 一度の列挙結果から連番を付け、完全一致を優先する。曖昧な接頭辞一致では選ばない。
fn resolve_named_device<T>(devices: impl Iterator<Item = (T, String)>, target: &str) -> Option<T> {
    let devices: Vec<_> = devices.collect();
    let mut counts = HashMap::new();
    for (_, name) in &devices {
        *counts.entry(name.clone()).or_insert(0_usize) += 1;
    }
    let mut indices = HashMap::new();
    let mut fallback = None;
    let mut ambiguous = false;
    let mut exact = None;
    let mut ambiguous_exact = false;
    for (device, name) in devices {
        let candidate = if counts[&name] > 1 {
            let index = indices.entry(name.clone()).or_insert(0_usize);
            *index += 1;
            format!("{} ({})", name, index)
        } else {
            name
        };
        if target == candidate {
            ambiguous_exact |= exact.is_some();
            exact = Some(device);
        } else if target.starts_with(&format!("{} [", candidate)) {
            ambiguous |= fallback.is_some();
            fallback = Some(device);
        }
    }
    if ambiguous_exact {
        None
    } else if exact.is_some() {
        exact
    } else if ambiguous {
        None
    } else {
        fallback
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn asio_pair_requires_equal_known_ids_and_clones_one_shared_state_only_for_asio() {
        use std::{cell::Cell, rc::Rc};
        #[derive(Clone)]
        struct Device {
            id: Option<u32>,
            shared: Rc<()>,
        }
        let make = |id| Device {
            id,
            shared: Rc::new(()),
        };
        let ids = Cell::new(0);
        let identity = |device: &Device| {
            ids.set(ids.get() + 1);
            device.id.ok_or_else(|| anyhow!("unknown ID"))
        };
        let input = make(Some(1));
        let discarded = Rc::downgrade(&input.shared);
        let output = make(Some(1));
        let expected = output.shared.clone();
        let (input, output) =
            DeviceManager::coordinated_pair(input, output, true, identity).unwrap();
        assert!(discarded.upgrade().is_none());
        assert!(Rc::ptr_eq(&input.shared, &output.shared));
        assert!(Rc::ptr_eq(&input.shared, &expected));
        assert_eq!(ids.get(), 2);
        assert!(
            DeviceManager::coordinated_pair(make(Some(1)), make(Some(2)), true, identity).is_err()
        );
        assert!(DeviceManager::coordinated_pair(make(None), make(None), true, identity).is_err());
        let before = ids.get();
        let (input, output) =
            DeviceManager::coordinated_pair(make(None), make(None), false, identity).unwrap();
        assert!(!Rc::ptr_eq(&input.shared, &output.shared));
        assert_eq!(ids.get(), before);
    }
    fn select(names: &[&str], target: &str) -> Option<usize> {
        resolve_named_device(
            names
                .iter()
                .enumerate()
                .map(|(index, name)| (index, (*name).into())),
            target,
        )
    }
    #[test]
    fn resolves_duplicate_indices_and_rate_suffix_from_one_snapshot() {
        assert_eq!(select(&["Mic", "Mic", "Out"], "Mic (2) [48kHz]"), Some(1));
        assert_eq!(select(&["Mic", "Mic"], "Mic"), None);
        assert_eq!(select(&["Mic"], "Mic [44.1kHz, 48kHz]"), Some(0));
        assert_eq!(select(&["Mic"], "Microphone"), None);
    }
    #[test]
    fn exact_name_wins_over_a_prefix_and_ambiguous_prefix_is_rejected() {
        assert_eq!(select(&["Mic", "Mic [USB]"], "Mic [USB]"), Some(1));
        assert_eq!(select(&["Mic", "Mic [USB]"], "Mic [USB] [48kHz]"), None);
        assert_eq!(select(&["Mic", "Mic (1)", "Mic"], "Mic (1)"), None);
    }

    #[test]
    fn asio_sequential_resolution_drops_each_unselected_driver_before_next() {
        use std::cell::Cell;
        use std::rc::Rc;
        struct Driver {
            index: usize,
            live: Rc<Cell<bool>>,
        }
        impl Drop for Driver {
            fn drop(&mut self) {
                self.live.set(false);
            }
        }
        struct Drivers {
            names: Vec<&'static str>,
            next: usize,
            live: Rc<Cell<bool>>,
        }
        impl Iterator for Drivers {
            type Item = (Driver, String);
            fn next(&mut self) -> Option<Self::Item> {
                // asio-sys同様、前のdriverを保持していたら他のdriverはロード不可。
                while self.next < self.names.len() {
                    let index = self.next;
                    self.next += 1;
                    if self.live.get() {
                        continue;
                    }
                    self.live.set(true);
                    return Some((
                        Driver {
                            index,
                            live: self.live.clone(),
                        },
                        self.names[index].into(),
                    ));
                }
                None
            }
        }
        let live = Rc::new(Cell::new(false));
        let names = vec!["Creative", "Other", "Voicemeeter Insert Virtual ASIO"];
        for target in [
            "Voicemeeter Insert Virtual ASIO",
            "Voicemeeter Insert Virtual ASIO [44/48/96kHz]",
        ] {
            let selected = resolve_asio_device(
                || {
                    Some(Drivers {
                        names: names.clone(),
                        next: 0,
                        live: live.clone(),
                    })
                },
                target,
            )
            .unwrap();
            assert_eq!(selected.index, 2);
            assert!(live.get());
            drop(selected);
            assert!(!live.get());
        }
    }

    #[test]
    fn asio_exact_names_precede_only_valid_rate_suffixes() {
        let names = ["Mic", "Mic [48kHz]", "Mic [USB]"];
        let select = |target| {
            resolve_asio_device(
                || {
                    Some(
                        names
                            .iter()
                            .enumerate()
                            .map(|(index, name)| (index, (*name).into())),
                    )
                },
                target,
            )
        };
        assert_eq!(select("Mic [48kHz]"), Some(1));
        assert_eq!(select("Mic [44/48/96kHz]"), Some(0));
        assert_eq!(select("Mic [44.1kHz, 48kHz]"), Some(0));
        assert_eq!(select("Mic [USB] [48kHz]"), Some(2));
        for target in [
            "Microphone",
            "Mic [USB other]",
            "Mic [48kHz] extra",
            "Mic [0kHz]",
            "Mic [NaNkHz]",
            "Mic [48//96kHz]",
        ] {
            assert_eq!(select(target), None);
        }
    }
}

#[cfg(test)]
mod scan_tests {
    use super::*;
    use std::time::Instant;

    fn device(name: &str) -> DeviceInfo {
        DeviceInfo {
            name: name.into(),
            host: "ASIO".into(),
            is_input: true,
            channels: 2,
            buffer_size_range: None,
            is_default: false,
        }
    }
    fn finish(manager: &mut DeviceManager, token: u64) -> DeviceScanStatus {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let result = manager.poll_scan(token).unwrap();
            if !matches!(result, DeviceScanStatus::Pending) {
                return result;
            }
            assert!(Instant::now() < deadline, "test worker did not finish");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn pending_scan_never_blocks_control_and_merges_only_current_active_devices() {
        let mut manager = DeviceManager::new();
        manager.set_active_input(device("old"));
        let (release, gate) = mpsc::channel();
        let token = manager
            .begin_scan_with(move |_| {
                gate.recv().unwrap();
                Ok(vec![device("scanned")])
            })
            .unwrap();
        for _ in 0..10 {
            assert!(matches!(
                manager.poll_scan(token).unwrap(),
                DeviceScanStatus::Pending
            ));
            assert!(manager.begin_scan_with(|_| Ok(Vec::new())).is_err());
        }
        // 検出中の停止・デバイス切替と同じ制御側操作を待たずに実施できる。
        manager.clear_active_devices();
        manager.set_active_input(device("current"));
        release.send(()).unwrap();
        let DeviceScanStatus::Completed(devices) = finish(&mut manager, token) else {
            panic!("not completed")
        };
        assert_eq!(
            devices
                .iter()
                .map(|device| device.name.as_str())
                .collect::<Vec<_>>(),
            ["scanned", "current"]
        );
        assert_eq!(manager.enumerate().unwrap().len(), 2);
        assert!(matches!(
            manager.poll_scan(token).unwrap(),
            DeviceScanStatus::Completed(_)
        ));
    }

    #[test]
    fn cancellation_rejects_late_success_and_old_tokens_cannot_cancel_next_scan() {
        let mut manager = DeviceManager::new();
        let (release, gate) = mpsc::channel();
        let first = manager
            .begin_scan_with(move |_| {
                gate.recv().unwrap();
                Ok(vec![device("late")])
            })
            .unwrap();
        manager.cancel_scan(first).unwrap();
        assert!(manager.begin_scan_with(|_| Ok(Vec::new())).is_err());
        release.send(()).unwrap();
        assert!(matches!(
            finish(&mut manager, first),
            DeviceScanStatus::Cancelled
        ));
        assert!(manager.enumerate().is_err());
        let next = manager
            .begin_scan_with(|_| Ok(vec![device("new")]))
            .unwrap();
        assert_ne!(first, next);
        assert!(manager.cancel_scan(first).is_err());
        assert!(manager.poll_scan(first).is_err());
        assert!(matches!(
            finish(&mut manager, next),
            DeviceScanStatus::Completed(_)
        ));
        assert_eq!(manager.cached_devices[0].name, "new");
    }

    #[test]
    fn failed_worker_and_panic_preserve_previous_cache() {
        let mut manager = DeviceManager::new();
        let first = manager
            .begin_scan_with(|_| Ok(vec![device("cached")]))
            .unwrap();
        finish(&mut manager, first);
        for panic_worker in [false, true] {
            let token = manager
                .begin_scan_with(move |_| {
                    assert!(!panic_worker, "injected scanner panic");
                    Err(anyhow!("scanner timeout or malformed output"))
                })
                .unwrap();
            assert!(matches!(
                finish(&mut manager, token),
                DeviceScanStatus::Failed(_)
            ));
            assert_eq!(manager.enumerate().unwrap()[0].name, "cached");
        }
    }

    #[test]
    fn manager_exit_cancels_and_reaps_worker() {
        let finished = Arc::new(AtomicBool::new(false));
        let observed = finished.clone();
        let mut manager = DeviceManager::new();
        manager
            .begin_scan_with(move |cancelled| {
                while !cancelled.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(1));
                }
                observed.store(true, Ordering::Release);
                Err(anyhow!("cancelled"))
            })
            .unwrap();
        drop(manager);
        assert!(finished.load(Ordering::Acquire));
    }
}
