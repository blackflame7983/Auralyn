//! VST の並び：保存からの復元・子が落ちたあとの読み直し・追加・削除・入れ替え・1つずつの設定・保存・候補の検索。

use super::*;

impl Control {
    /// 保存した並びを、同じ順・同じ ON/OFF・同じ VST の中の設定で読む。保存が無ければ何もしない。
    pub(super) fn restore_saved(&mut self) {
        let text = match std::fs::read_to_string(self.config_dir.join(RACK_FILE)) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => {
                self.fail("read_rack", e.into());
                return self.set_aside();
            }
        };
        match serde_json::from_str::<Vec<RestorePluginRequest>>(&text) {
            Ok(requests) => requests.into_iter().for_each(|r| self.restore(r)),
            Err(e) => {
                self.fail("read_rack", e.into());
                self.set_aside();
            }
        }
        self.send_rack();
    }

    /// 読めなかった保存を、次の保存で上書きしないよう `.bad` へ移す。移せなければ、この起動の間は保存しない。
    pub(super) fn set_aside(&mut self) {
        let path = self.config_dir.join(RACK_FILE);
        if let Err(e) = std::fs::rename(&path, path.with_extension("json.bad")) {
            self.fail("read_rack", e.into());
            self.read_only = true;
        }
    }

    /// 子が落ちていたら、次の子（空で始まる）に並びを、最後に保存した VST の中の設定で読み直す。
    /// 開始のあとと、VST を足す前に呼ぶ（足すと子が起き、落ちる前の並びが消えたままになる）。
    /// 復旧で選んだ `hold` の VST は読まずに並びへ残す。
    pub(super) fn recover(&mut self) {
        if !self.exited.swap(false, Ordering::SeqCst) {
            return;
        }
        let old = std::mem::take(&mut self.rack);
        self.renamed = old.iter().map(|slot| slot.id.clone()).collect();
        let hold = self.hold.take();
        for slot in old {
            if hold
                .as_ref()
                .is_some_and(|h| h.holds(&slot.path, slot.class_id.as_deref()))
            {
                // 読まずに、保存にある設定のまま「読めていない」枠として残す（保存からも消さない）。
                let id = self.placeholder();
                self.rack.push(Slot {
                    id,
                    loaded: false,
                    ..slot
                });
            } else {
                self.restore(slot.request());
            }
        }
        // 新しい子の音づくりは既定値で始まるので、落ちる前の設定を送り直す。
        if let Some(sound) = self.sound {
            self.apply_sound(sound, None);
        }
        self.send_rack();
    }

    /// 復旧で選んだ VST を、読み直したあとの子から外して「読めていない」枠にする。
    /// 選ぶ前に音づくりを開くなどで、子が落ちる前の並びをもう読み直していたときに使う。
    pub(super) fn hold_loaded(&mut self, hold: &Hold) {
        let ids: Vec<String> = self.rack.iter().map(|slot| slot.id.clone()).collect();
        for index in 0..self.rack.len() {
            let slot = &self.rack[index];
            if !slot.loaded || !hold.holds(&slot.path, slot.class_id.as_deref()) {
                continue;
            }
            if let Err(e) = self.host.remove_plugin(&slot.id) {
                self.fail("remove_plugin", e);
                continue;
            }
            let id = self.placeholder();
            let slot = &mut self.rack[index];
            slot.loaded = false;
            slot.id = id;
        }
        self.renamed = ids;
        self.changed();
    }

    /// 「読めていない」枠の仮の ID。
    fn placeholder(&mut self) -> String {
        self.placeholders += 1;
        format!("missing-{}", self.placeholders)
    }

    /// 1つ読む。返すのは ID・名前・種類。音量は並びに入れるとき（`restore`）にそろえてある。
    fn reload(
        &mut self,
        request: RestorePluginRequest,
    ) -> anyhow::Result<(String, String, Option<String>)> {
        let class_id = request.class_id.clone();
        let plugin = self.host.restore_plugin(request)?;
        Ok((plugin.id, plugin.name, plugin.class_id.or(class_id)))
    }

    /// 読めていない VST を、同じ位置のまま読み直す。読めたら子の中の順を並びに合わせる。
    pub(super) fn reload_missing(&mut self) {
        // 子が落ちていたら、読み直し（`recover`）が読めていない枠も含めて全部読むので、それで終わり。
        if self.exited.load(Ordering::SeqCst) {
            return self.recover();
        }
        let ids: Vec<String> = self.rack.iter().map(|slot| slot.id.clone()).collect();
        let mut reloaded = false;
        for index in 0..self.rack.len() {
            if self.rack[index].loaded {
                continue;
            }
            match self.reload(self.rack[index].request()) {
                Ok((id, name, class_id)) => {
                    let slot = &mut self.rack[index];
                    slot.id = id;
                    slot.name = name;
                    slot.loaded = true;
                    slot.class_id = class_id;
                    reloaded = true;
                }
                Err(e) => self.fail("restore_plugin", e),
            }
            // 読んだ VST で子が落ちたら、ここで止める（続けて読むと新しい子が起き、あとの読み直しと二重になる）。
            // 並びは次の操作か開始のときに `recover` が読み直す。
            if self.exited.load(Ordering::SeqCst) {
                break;
            }
        }
        self.renamed = ids;
        if reloaded && !self.exited.load(Ordering::SeqCst) {
            // 子は読んだ VST を末尾に足すので、並びの順へ戻す。
            let order = self
                .rack
                .iter()
                .filter(|slot| slot.loaded)
                .map(|slot| slot.id.clone())
                .collect();
            if let Err(e) = self.host.reorder_plugins(order) {
                self.fail("reorder_plugins", e);
            }
        }
        self.changed();
    }

    /// 1つ読んで並びの末尾に足す。読めなければ理由を出し、同じ位置に「読めていない」枠として残す（保存から消さず、順も変えない）。
    pub(super) fn restore(&mut self, mut request: RestorePluginRequest) {
        // 手で書き換えた保存でも、画面に出せる範囲（0〜200%）で鳴らす。
        request.gain = rack::gain_from_percent(rack::gain_percent(request.gain));
        let (id, name, loaded, class_id) = match self.reload(request.clone()) {
            Ok((id, name, class_id)) => (id, name, true, class_id),
            Err(e) => {
                self.fail("restore_plugin", e);
                let name = Path::new(&request.path).file_stem().map_or_else(
                    || request.path.clone(),
                    |s| s.to_string_lossy().into_owned(),
                );
                (self.placeholder(), name, false, request.class_id)
            }
        };
        self.rack.push(Slot {
            id,
            name,
            enabled: !request.bypassed,
            muted: request.muted,
            gain: request.gain,
            loaded,
            path: request.path,
            class_id,
            state: request.state,
        });
    }

    pub(super) fn add(&mut self, path: &str, class_id: Option<&str>) {
        self.recover();
        if let Some((id, name, binary, class_id)) = self.load(path, class_id) {
            self.rack.push(Slot {
                id,
                name,
                enabled: true,
                muted: false,
                gain: 1.0,
                loaded: true,
                path: binary,
                class_id,
                state: None,
            });
        }
        self.changed();
    }

    /// 並びを保存する。`fresh` なら各 VST の中の設定も取り直す（取れなかった VST は前の設定のまま）。
    pub(super) fn save(&mut self, fresh: bool) {
        if self.read_only {
            return;
        }
        for slot in self.rack.iter_mut().filter(|slot| fresh && slot.loaded) {
            match self.host.get_plugin_state(&slot.id) {
                Ok(state) => slot.state = Some(state),
                Err(e) => log::warn!("{} の設定を取れません: {e}", slot.name),
            }
        }
        let requests: Vec<RestorePluginRequest> = self.rack.iter().map(Slot::request).collect();
        let path = self.config_dir.join(RACK_FILE);
        let result = serde_json::to_vec(&requests)
            .map_err(anyhow::Error::from)
            .and_then(|bytes| Ok(store::write_atomic(&path, &bytes)?));
        if let Err(e) = result {
            self.fail("save_rack", e);
        }
    }

    /// 並びを変えようとしたあと（成功でも失敗でも）。画面へ並び全体を送ってから保存する。
    /// 中の設定は取り直さない（変わるのは VST の窓の中だけで、窓を閉じたときと止めたときに取る）。
    pub(super) fn changed(&mut self) {
        self.send_rack();
        self.save(false);
    }

    /// `.vst3` のバンドル（フォルダ）を渡されたら、スキャンと同じく中の実体（Contents/x86_64-win）を探して読む。
    /// 読めたら、子が付けた ID と名前と、読んだ実体のパス。
    pub(super) fn load(
        &mut self,
        path: &str,
        class_id: Option<&str>,
    ) -> Option<(String, String, String, Option<String>)> {
        let binary = scanner::resolve_binary(Path::new(path));
        let Some(binary) = binary.as_deref().and_then(Path::to_str) else {
            let _ = self.notices.send(Notice::Failed {
                command: "load_plugin",
                message: format!("VST3 の実体が見つかりません: {path}"),
            });
            return None;
        };
        log::info!("VST3 を読み込む: {binary}");
        match self.host.load_plugin(binary, class_id) {
            Ok(plugin) => Some((
                plugin.id,
                plugin.name,
                binary.to_owned(),
                plugin.class_id.or(class_id.map(str::to_owned)),
            )),
            Err(e) => {
                self.fail("load_plugin", e);
                None
            }
        }
    }

    pub(super) fn send_rack(&self) {
        let _ = self.notices.send(Notice::Rack(self.rack.clone()));
    }

    pub(super) fn position(&self, id: &str) -> Option<usize> {
        let index = self.rack.iter().position(|slot| slot.id == id);
        index.or_else(|| self.renamed.iter().position(|old| old == id))
    }

    pub(super) fn remove(&mut self, id: &str) {
        let Some(index) = self.position(id) else {
            return;
        };
        // 子が落ちていたら、子に聞かずに並びから外す（落ちる原因の VST を、音を出さずに外せるように）。
        let result = if self.rack[index].loaded && !self.exited.load(Ordering::SeqCst) {
            // 画面の ID は読み直す前のものかもしれないので、同じ位置の今の ID で頼む。
            let id = self.rack[index].id.clone();
            self.host.remove_plugin(&id)
        } else {
            Ok(())
        };
        match result {
            Ok(()) => {
                self.rack.remove(index);
                // 位置がずれるので、古い ID では当てない。
                self.renamed.clear();
            }
            Err(e) => self.fail("remove_plugin", e),
        }
        self.changed();
    }

    /// 並びの1つへの命令の前に、子が落ちていたら読み直す。読み直すと ID が変わるので、同じ位置の今の ID を返す。
    pub(super) fn live(&mut self, id: &str) -> Option<(usize, String)> {
        let index = self.position(id)?;
        self.recover();
        Some((index, self.rack.get(index)?.id.clone()))
    }

    pub(super) fn shift(&mut self, id: &str, up: bool) {
        let Some((index, _)) = self.live(id) else {
            return;
        };
        let items: Vec<(String, bool)> = self
            .rack
            .iter()
            .map(|slot| (slot.id.clone(), slot.loaded))
            .collect();
        let Some((other, order)) = rack::reordered(&items, index, up) else {
            return;
        };
        match self.host.reorder_plugins(order) {
            Ok(()) => {
                self.rack.swap(index, other);
                self.renamed.clear();
            }
            Err(e) => self.fail("reorder_plugins", e),
        }
        self.changed();
    }

    /// 並びの1つを子へ頼み、受け付けられたら枠を書き換える（ON/OFF・ミュート・音量）。
    pub(super) fn edit(
        &mut self,
        id: &str,
        name: &'static str,
        call: impl FnOnce(&mut AudioHost, &str) -> anyhow::Result<()>,
        apply: impl FnOnce(&mut Slot),
    ) {
        let Some((index, id)) = self.live(id) else {
            return;
        };
        match call(&mut self.host, &id) {
            Ok(()) => apply(&mut self.rack[index]),
            Err(e) => self.fail(name, e),
        }
        self.changed();
    }

    /// スキャンは VST ごとに別のプロセスで調べるので時間がかかる。命令のスレッドを塞がないよう、別のスレッドで行う。
    pub(super) fn scan(&self) {
        let config_dir = self.config_dir.clone();
        let notices = self.notices.clone();
        let spawned = std::thread::Builder::new()
            .name("gpui-scan".into())
            .spawn(move || {
                let result = std::fs::create_dir_all(&config_dir)
                    .map_err(|e| e.to_string())
                    .and_then(|()| {
                        let extra = crate::scan_file::load(&config_dir);
                        scanner::scan_plugin_catalog(
                            &config_dir,
                            vst_host_lib::vst_host::catalog::ScanMode::Incremental,
                            &extra,
                        )
                    })
                    .map(|catalog| {
                        let candidates = catalog
                            .plugins
                            .into_iter()
                            .map(|p| Candidate {
                                name: p.name,
                                vendor: p.vendor,
                                category: p.sub_categories,
                                path: p.path,
                                class_id: p.class_id,
                            })
                            .collect();
                        (candidates, catalog.skipped_roots)
                    });
                let _ = notices.send(Notice::Catalog(result));
            });
        if let Err(e) = spawned {
            let _ = self.notices.send(Notice::Catalog(Err(e.to_string())));
        }
    }
}
