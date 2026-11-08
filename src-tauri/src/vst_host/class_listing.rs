//! VST3 factory のクラス列挙。
//!
//! `list_effect_classes` は `createInstance` を呼ばない。
//! 列挙に成功しても、そのクラスを音声処理できる保証にはならない。
use crate::vst_host::c_api::{
    IPluginFactory2Vtbl, IPluginFactoryVtbl, PClassInfo, PClassInfo2, IID_IPLUGINFACTORY2,
    K_RESULT_OK, TUID,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::ffi::{c_char, c_void};

pub const AUDIO_MODULE_CATEGORY: &str = "Audio Module Class";
pub const SCAN_FORMAT_VERSION: u32 = 2;
pub const NO_EFFECT_ERROR: &str = "対応するエフェクトがありません";

/// クラス情報の取得元。lossy な文字列でも、この値で classInfo2 と classInfo を区別する。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClassInfoSource {
    #[serde(rename = "classInfo2")]
    ClassInfo2,
    #[serde(rename = "classInfo")]
    ClassInfo,
}

/// エフェクト候補の1クラス。同名は CID で区別し、同じ CID は最初の1件だけを残す。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassEntry {
    /// 16バイト CID の32桁大文字16進。
    pub class_id: String,
    pub name: Option<String>,
    pub vendor: Option<String>,
    pub version: Option<String>,
    pub sub_categories: Option<String>,
    pub info_source: ClassInfoSource,
    /// v1 の classInfo だけではサブカテゴリが無く、楽器かエフェクトか決められない。
    pub kind_known: bool,
}

/// 列挙結果。`cid` は createInstance に渡す生バイトで、スキャナー出力には含めない。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedClass {
    pub entry: ClassEntry,
    pub cid: TUID,
}

#[derive(Debug)]
pub struct ClassListError {
    message: String,
}

impl ClassListError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ClassListError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ClassListError {}

pub fn format_class_id(cid: &TUID) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(32);
    for byte in cid {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// 32桁の16進だけを受け、大文字に揃える。
pub fn normalize_class_id(value: &str) -> Option<String> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(value.to_ascii_uppercase())
}

/// NUL 終端までを読む。終端が無い、または UTF-8 でなければ lossy 変換する。空は None。
pub fn decode_fixed_c_string(buf: &[c_char]) -> Option<String> {
    let end = buf.iter().position(|&ch| ch == 0).unwrap_or(buf.len());
    if end == 0 {
        return None;
    }
    let bytes: Vec<u8> = buf[..end].iter().map(|ch| *ch as u8).collect();
    let text = String::from_utf8_lossy(&bytes);
    if text.is_empty() {
        None
    } else {
        Some(text.into_owned())
    }
}

/// `Instrument` を含み `Fx` を含まないサブカテゴリは楽器として除外する。
pub fn keep_effect_subcategories(sub_categories: &str) -> bool {
    let mut instrument = false;
    let mut fx = false;
    for token in sub_categories
        .split('|')
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        if token.starts_with("Instrument") {
            instrument = true;
        }
        if token.starts_with("Fx") {
            fx = true;
        }
    }
    !(instrument && !fx)
}

struct Factory2Guard(*mut c_void);

impl Drop for Factory2Guard {
    fn drop(&mut self) {
        if self.0.is_null() {
            return;
        }
        // SAFETY: QueryInterface 成功時に受け取った参照を、列挙の終了時に1回だけ解放する。
        unsafe {
            let vtbl = vtbl::<IPluginFactoryVtbl>(self.0);
            (vtbl.base.release)(self.0);
        }
    }
}

unsafe fn vtbl<T>(ptr: *mut c_void) -> &'static T {
    &**(ptr as *mut *const T)
}

/// factory からエフェクト候補を集める。実体は生成しない。
///
/// IPluginFactory2 を取得できれば getClassInfo2、失敗すれば v1 の getClassInfo を使う。
///
/// # Safety
///
/// `factory_ptr` は呼び出しの間生存する `IPluginFactory` である。null はエラーを返す。
/// 戻り値はポインタを保持しない。
pub unsafe fn list_effect_classes(
    factory_ptr: *mut c_void,
) -> Result<Vec<ListedClass>, ClassListError> {
    if factory_ptr.is_null() {
        return Err(ClassListError::new("ファクトリがありません"));
    }
    // SAFETY: factory_ptr は呼び出し側が解放まで生存させる IPluginFactory。
    // QueryInterface の追加参照は Factory2Guard が解放する。createInstance は呼ばない。
    unsafe {
        let factory = vtbl::<IPluginFactoryVtbl>(factory_ptr);
        let mut factory2_ptr: *mut c_void = std::ptr::null_mut();
        let queried =
            (factory.base.query_interface)(factory_ptr, &IID_IPLUGINFACTORY2, &mut factory2_ptr);
        let factory2 = if queried == K_RESULT_OK && !factory2_ptr.is_null() {
            Some(Factory2Guard(factory2_ptr))
        } else {
            None
        };
        let info_ptr = factory2
            .as_ref()
            .map(|guard| guard.0)
            .unwrap_or(factory_ptr);
        let info_vtbl = vtbl::<IPluginFactoryVtbl>(info_ptr);
        let count = (info_vtbl.count_classes)(info_ptr);
        if count < 0 {
            return Err(ClassListError::new("クラス数を取得できません"));
        }
        let mut listed = Vec::new();
        let mut seen = HashSet::new();
        for index in 0..count {
            let Some(class) = read_class(info_ptr, factory2.is_some(), index) else {
                continue;
            };
            if !seen.insert(class.entry.class_id.clone()) {
                continue;
            }
            listed.push(class);
        }
        Ok(listed)
    }
}

unsafe fn read_class(factory: *mut c_void, factory2: bool, index: i32) -> Option<ListedClass> {
    if factory2 {
        let vtbl = vtbl::<IPluginFactory2Vtbl>(factory);
        let mut info = std::mem::zeroed::<PClassInfo2>();
        if (vtbl.get_class_info2)(factory, index, &mut info) == K_RESULT_OK {
            return class_from_info2(&info);
        }
    }
    let vtbl = vtbl::<IPluginFactoryVtbl>(factory);
    let mut info = std::mem::zeroed::<PClassInfo>();
    if (vtbl.get_class_info)(factory, index, &mut info) != K_RESULT_OK {
        return None;
    }
    class_from_info(&info)
}

fn class_from_info2(info: &PClassInfo2) -> Option<ListedClass> {
    let category = decode_fixed_c_string(&info.category)?;
    if category != AUDIO_MODULE_CATEGORY {
        return None;
    }
    let sub_categories = decode_fixed_c_string(&info.sub_categories);
    if sub_categories
        .as_deref()
        .is_some_and(|value| !keep_effect_subcategories(value))
    {
        return None;
    }
    Some(listed(
        info.cid,
        decode_fixed_c_string(&info.name),
        decode_fixed_c_string(&info.vendor),
        decode_fixed_c_string(&info.version),
        sub_categories,
        ClassInfoSource::ClassInfo2,
        true,
    ))
}

fn class_from_info(info: &PClassInfo) -> Option<ListedClass> {
    let category = decode_fixed_c_string(&info.category)?;
    if category != AUDIO_MODULE_CATEGORY {
        return None;
    }
    Some(listed(
        info.cid,
        decode_fixed_c_string(&info.name),
        None,
        None,
        None,
        ClassInfoSource::ClassInfo,
        false,
    ))
}

/// スキャナー子プロセスの1行JSON。`formatVersion` が無い旧出力はホスト側で別に読む。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub format_version: u32,
    pub path: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// ホストが失敗種別を決めるための語。無い旧出力から理由は推定しない。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factory_vendor: Option<String>,
    #[serde(default)]
    pub classes: Vec<ClassEntry>,
}

fn listed(
    cid: TUID,
    name: Option<String>,
    vendor: Option<String>,
    version: Option<String>,
    sub_categories: Option<String>,
    info_source: ClassInfoSource,
    kind_known: bool,
) -> ListedClass {
    ListedClass {
        entry: ClassEntry {
            class_id: format_class_id(&cid),
            name,
            vendor,
            version,
            sub_categories,
            info_source,
            kind_known,
        },
        cid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vst_host::c_api::{FUnknownVtbl, PFactoryInfo, TResult};
    use std::cell::RefCell;

    static CREATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    struct Spec {
        cid: TUID,
        category: Vec<u8>,
        name: Vec<u8>,
        sub_categories: Option<Vec<u8>>,
        vendor: Option<Vec<u8>>,
        version: Option<Vec<u8>>,
    }

    struct Catalog {
        classes: Vec<Spec>,
        factory2: bool,
    }

    thread_local! {
        static CATALOG: RefCell<Catalog> = const { RefCell::new(Catalog { classes: Vec::new(), factory2: true }) };
    }

    #[repr(C)]
    struct Obj {
        vtable: *const IPluginFactory2Vtbl,
        refs: i32,
    }

    fn write_field(dst: &mut [c_char], src: &[u8]) {
        for (index, byte) in src.iter().take(dst.len()).enumerate() {
            dst[index] = *byte as c_char;
        }
    }

    fn text(value: &str) -> Vec<u8> {
        let mut bytes = value.as_bytes().to_vec();
        bytes.push(0);
        bytes
    }

    fn spec(cid: u8, name: &str, sub: Option<&str>) -> Spec {
        Spec {
            cid: [cid; 16],
            category: text(AUDIO_MODULE_CATEGORY),
            name: text(name),
            sub_categories: sub.map(text),
            vendor: Some(text("Vendor")),
            version: Some(text("1.2.3")),
        }
    }

    unsafe extern "system" fn query(
        this: *mut c_void,
        iid: *const TUID,
        out: *mut *mut c_void,
    ) -> TResult {
        *out = std::ptr::null_mut();
        let supported = CATALOG.with(|catalog| catalog.borrow().factory2);
        // SAFETY: iid は QueryInterface の呼び出し元が指す 16 バイト。
        if supported && unsafe { *iid } == IID_IPLUGINFACTORY2 {
            *out = this;
            add_ref(this);
            return K_RESULT_OK;
        }
        vst3::Steinberg::kNoInterface
    }

    unsafe extern "system" fn add_ref(this: *mut c_void) -> u32 {
        // SAFETY: this は list が渡す Obj。列挙の同期呼び出し中だけ生存する。
        let obj = unsafe { &mut *this.cast::<Obj>() };
        obj.refs += 1;
        obj.refs as u32
    }

    unsafe extern "system" fn release(this: *mut c_void) -> u32 {
        // SAFETY: this は list が渡す Obj。参照が残っている間だけ解放する。
        let obj = unsafe { &mut *this.cast::<Obj>() };
        obj.refs -= 1;
        obj.refs as u32
    }

    unsafe extern "system" fn factory_info(_: *mut c_void, _: *mut PFactoryInfo) -> TResult {
        K_RESULT_OK
    }

    unsafe extern "system" fn count(this: *mut c_void) -> i32 {
        let _ = this;
        CATALOG.with(|catalog| catalog.borrow().classes.len() as i32)
    }

    unsafe extern "system" fn class_info(
        _: *mut c_void,
        index: i32,
        info: *mut PClassInfo,
    ) -> TResult {
        let spec = CATALOG.with(|catalog| {
            catalog
                .borrow()
                .classes
                .get(index as usize)
                .map(|spec| (spec.cid, spec.category.clone(), spec.name.clone()))
        });
        let Some((cid, category, name)) = spec else {
            return vst3::Steinberg::kResultFalse;
        };
        // SAFETY: info は getClassInfo が渡す PClassInfo。呼び出し中だけ書き込む。
        unsafe {
            (*info).cid = cid;
            write_field(&mut (*info).category, &category);
            write_field(&mut (*info).name, &name);
        }
        K_RESULT_OK
    }

    unsafe extern "system" fn class_info2(
        _: *mut c_void,
        index: i32,
        info: *mut PClassInfo2,
    ) -> TResult {
        let spec =
            CATALOG.with(|catalog| catalog.borrow().classes.get(index as usize).map(spec_parts));
        let Some((cid, category, name, sub, vendor, version)) = spec else {
            return vst3::Steinberg::kResultFalse;
        };
        // SAFETY: info は getClassInfo2 が渡す PClassInfo2。呼び出し中だけ書き込む。
        unsafe {
            (*info).cid = cid;
            write_field(&mut (*info).category, &category);
            write_field(&mut (*info).name, &name);
            if let Some(sub) = sub {
                write_field(&mut (*info).sub_categories, &sub);
            }
            if let Some(vendor) = vendor {
                write_field(&mut (*info).vendor, &vendor);
            }
            if let Some(version) = version {
                write_field(&mut (*info).version, &version);
            }
        }
        K_RESULT_OK
    }

    type SpecParts = (
        TUID,
        Vec<u8>,
        Vec<u8>,
        Option<Vec<u8>>,
        Option<Vec<u8>>,
        Option<Vec<u8>>,
    );

    fn spec_parts(spec: &Spec) -> SpecParts {
        (
            spec.cid,
            spec.category.clone(),
            spec.name.clone(),
            spec.sub_categories.clone(),
            spec.vendor.clone(),
            spec.version.clone(),
        )
    }

    unsafe extern "system" fn create(
        _: *mut c_void,
        _: *const TUID,
        _: *const TUID,
        out: *mut *mut c_void,
    ) -> TResult {
        // SAFETY: out は createInstance の出力参照。呼ばれた事実だけを記録する。
        unsafe {
            *out = std::ptr::null_mut();
        }
        CREATED.store(true, std::sync::atomic::Ordering::SeqCst);
        vst3::Steinberg::kResultFalse
    }

    fn base() -> FUnknownVtbl {
        FUnknownVtbl {
            query_interface: query,
            add_ref,
            release,
        }
    }

    fn factory() -> IPluginFactoryVtbl {
        IPluginFactoryVtbl {
            base: base(),
            get_factory_info: factory_info,
            count_classes: count,
            get_class_info: class_info,
            create_instance: create,
        }
    }

    fn factory2() -> IPluginFactory2Vtbl {
        IPluginFactory2Vtbl {
            base: factory(),
            get_class_info2: class_info2,
        }
    }

    fn list(classes: Vec<Spec>, factory2_supported: bool) -> (Vec<ListedClass>, i32) {
        CREATED.store(false, std::sync::atomic::Ordering::SeqCst);
        CATALOG.with(|catalog| {
            *catalog.borrow_mut() = Catalog {
                classes,
                factory2: factory2_supported,
            };
        });
        let vtable = factory2();
        let mut obj = Obj {
            vtable: &vtable,
            refs: 1,
        };
        // SAFETY: obj と vtable はこの呼び出しの間生存し、createInstance は失敗するだけで実体を作らない。
        let listed = unsafe { list_effect_classes((&mut obj as *mut Obj).cast()) }.unwrap();
        let refs = obj.refs;
        (listed, refs)
    }

    #[test]
    fn pclassinfo2_matches_the_sdk_field_sizes() {
        assert_eq!(std::mem::size_of::<PClassInfo2>(), 440);
        assert_eq!(
            IID_IPLUGINFACTORY2,
            <vst3::Steinberg::IPluginFactory2 as vst3::Interface>::IID
        );
    }

    #[test]
    fn subcategory_rule_keeps_fx_and_drops_instrument_only() {
        assert!(keep_effect_subcategories("Fx|Delay"));
        assert!(keep_effect_subcategories("Fx|Instrument"));
        assert!(keep_effect_subcategories("Analyzer"));
        assert!(keep_effect_subcategories(""));
        assert!(!keep_effect_subcategories("Instrument"));
        assert!(!keep_effect_subcategories("Instrument|Synth"));
    }

    #[test]
    fn factory2_lists_effects_and_skips_instruments_duplicate_cids_and_creation() {
        let (listed, refs) = list(
            vec![
                spec(1, "Delay", Some("Fx|Delay")),
                spec(1, "Delay copy", Some("Fx|Delay")),
                spec(2, "Delay", Some("Fx|Dynamics")),
                spec(3, "Piano", Some("Instrument|Synth")),
                spec(4, "Hybrid", Some("Fx|Instrument")),
                {
                    let mut controller = spec(5, "Controller", None);
                    controller.category = text("Component Controller Class");
                    controller
                },
            ],
            true,
        );
        assert_eq!(refs, 1);
        assert!(!CREATED.load(std::sync::atomic::Ordering::SeqCst));
        let names: Vec<_> = listed
            .iter()
            .map(|class| class.entry.name.as_deref())
            .collect();
        assert_eq!(names, vec![Some("Delay"), Some("Delay"), Some("Hybrid")]);
        assert_eq!(listed[0].entry.class_id, format_class_id(&[1; 16]));
        assert_ne!(listed[0].entry.class_id, listed[1].entry.class_id);
        assert_eq!(listed[0].entry.info_source, ClassInfoSource::ClassInfo2);
        assert!(listed[0].entry.kind_known);
        assert_eq!(listed[0].entry.vendor.as_deref(), Some("Vendor"));
        assert_eq!(listed[0].entry.version.as_deref(), Some("1.2.3"));
        assert_eq!(listed[0].entry.sub_categories.as_deref(), Some("Fx|Delay"));
    }

    #[test]
    fn empty_factory_has_no_classes() {
        let (listed, refs) = list(Vec::new(), true);
        assert!(listed.is_empty());
        assert_eq!(refs, 1);
    }

    #[test]
    fn v1_factory_includes_audio_modules_with_unknown_kind() {
        let (listed, _) = list(vec![spec(7, "Only V1", Some("Instrument"))], false);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].entry.info_source, ClassInfoSource::ClassInfo);
        assert!(!listed[0].entry.kind_known);
        assert!(listed[0].entry.sub_categories.is_none());
        assert!(listed[0].entry.vendor.is_none());
        assert!(listed[0].entry.version.is_none());
    }

    #[test]
    fn missing_nul_and_invalid_utf8_are_lossy_and_keep_the_source() {
        let mut raw = spec(8, "unused", Some("Fx"));
        raw.name = vec![0xFF; 64];
        raw.vendor = Some(Vec::new());
        raw.version = Some(vec![0]);
        let (listed, _) = list(vec![raw], true);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].entry.info_source, ClassInfoSource::ClassInfo2);
        assert!(listed[0]
            .entry
            .name
            .as_deref()
            .is_some_and(|name| name.contains('\u{FFFD}')));
        assert!(listed[0].entry.vendor.is_none());
        assert!(listed[0].entry.version.is_none());
    }

    #[test]
    fn class_id_normalization_accepts_only_32_hex_digits() {
        assert_eq!(
            normalize_class_id("aabbccddeeff00112233445566778899").as_deref(),
            Some("AABBCCDDEEFF00112233445566778899")
        );
        assert!(normalize_class_id("abc").is_none());
        assert!(normalize_class_id("zzbbccddeeff00112233445566778899").is_none());
        assert_eq!(format_class_id(&[0; 16]).len(), 32);
    }
}
