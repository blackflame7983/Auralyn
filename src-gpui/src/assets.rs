//! 画面で使うアイコン。GPUI Kit の既定の組に無いものだけを足す（全部の Lucide を入れると実行ファイルが大きくなる）。

use std::borrow::Cow;

use gpui_kit::assets::{icon_assets, Assets};
use gpui_kit::{AssetSource, Result, SharedString};

icon_assets!(
    Extra,
    [
        House,
        AudioLines,
        Puzzle,
        Cable,
        ListChecks,
        Music,
        SlidersHorizontal,
        AudioWaveform,
        ListMusic,
        Sparkles,
        Wind,
        WandSparkles,
        Orbit,
        Speech,
        Shield,
        ShieldCheck,
        Radio,
        Headphones,
        MicVocal,
        Layers,
        FolderSearch,
        Languages,
        Monitor,
        Keyboard,
        Stethoscope,
        LifeBuoy,
        Cast,
    ]
);

pub struct AppAssets;

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if let Some(bytes) = Extra.load(path)? {
            return Ok(Some(bytes));
        }
        Assets.load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut paths = Assets.list(path)?;
        paths.extend(Extra.list(path)?);
        paths.sort();
        paths.dedup();
        Ok(paths)
    }
}
