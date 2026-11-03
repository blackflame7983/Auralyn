use anyhow::{anyhow, ensure, Result};
use serde::{Deserialize, Serialize};
use std::{
    cell::UnsafeCell,
    mem::size_of,
    ptr::NonNull,
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc,
    },
};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, INVALID_HANDLE_VALUE,
        },
        System::{
            Com::CoCreateGuid,
            Memory::{
                CreateFileMappingW, MapViewOfFile, OpenFileMappingW, UnmapViewOfFile,
                FILE_MAP_ALL_ACCESS, MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
            },
        },
    },
};

pub const BLOCK_FRAMES: usize = 512;
pub const PROTOCOL: u32 = 1;
pub const TRANSPORT_LATENCY_FRAMES: u32 = (BLOCK_FRAMES * 4) as u32;
const CAPACITY: u64 = 8;
const PREFIX: &str = "Local\\AuralynPostMix-";
const MAGIC: u64 = 0x4155_5241_504d_4958;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Descriptor {
    pub name: String,
    pub sample_rate: u32,
    pub protocol: u32,
}

#[derive(Clone, Copy)]
#[repr(C)]
pub struct Packet {
    pub sequence: u64,
    pub generation: u64,
    pub bypassed: u32,
    pub samples: [[f32; 2]; BLOCK_FRAMES],
}
impl Default for Packet {
    fn default() -> Self {
        Self {
            sequence: 0,
            generation: 0,
            bypassed: 0,
            samples: [[0.0; 2]; BLOCK_FRAMES],
        }
    }
}

#[repr(C, align(64))]
struct Index(AtomicU64);
#[repr(C)]
struct Ring {
    read: Index,
    write: Index,
    slots: [UnsafeCell<Packet>; CAPACITY as usize],
}
impl Ring {
    fn new() -> Self {
        Self {
            read: Index(AtomicU64::new(0)),
            write: Index(AtomicU64::new(0)),
            slots: std::array::from_fn(|_| UnsafeCell::new(Packet::default())),
        }
    }
    fn push(&self, packet: &Packet) -> bool {
        let write = self.write.0.load(Ordering::Relaxed);
        let read = self.read.0.load(Ordering::Acquire);
        let len = write.wrapping_sub(read);
        if len >= CAPACITY {
            return false;
        }
        // producer は空きスロットだけを書き、公開後は consumer の read 更新まで再利用しない。
        unsafe {
            *self.slots[(write % CAPACITY) as usize].get() = *packet;
        }
        self.write.0.store(write.wrapping_add(1), Ordering::Release);
        true
    }
    fn pop(&self, packet: &mut Packet) -> bool {
        let read = self.read.0.load(Ordering::Relaxed);
        let write = self.write.0.load(Ordering::Acquire);
        let len = write.wrapping_sub(read);
        if len == 0 || len > CAPACITY {
            return false;
        }
        // acquire で完成したスロットを読み、コピー完了後に release して再利用を許す。
        unsafe {
            *packet = *self.slots[(read % CAPACITY) as usize].get();
        }
        self.read.0.store(read.wrapping_add(1), Ordering::Release);
        true
    }
}
#[repr(C)]
struct Shared {
    ready: AtomicU32,
    magic: u64,
    protocol: u32,
    rate: u32,
    size: u32,
    client_claim: AtomicU32,
    worker_claim: AtomicU32,
    failed: AtomicU32,
    worker_ready: AtomicU32,
    latency: AtomicU64,
    input: Ring,
    output: Ring,
}
impl Shared {
    fn new(rate: u32) -> Self {
        Self {
            ready: AtomicU32::new(0),
            magic: MAGIC,
            protocol: PROTOCOL,
            rate,
            size: size_of::<Self>() as u32,
            client_claim: AtomicU32::new(0),
            worker_claim: AtomicU32::new(0),
            failed: AtomicU32::new(0),
            worker_ready: AtomicU32::new(0),
            latency: AtomicU64::new(u64::MAX),
            input: Ring::new(),
            output: Ring::new(),
        }
    }
}
struct View {
    handle: HANDLE,
    address: NonNull<Shared>,
}
// 共有データは atomic と SPSC の排他的なスロット所有権で同期する。
unsafe impl Send for View {}
unsafe impl Sync for View {}
impl View {
    fn shared(&self) -> &Shared {
        unsafe { self.address.as_ref() }
    }
}
impl Drop for View {
    fn drop(&mut self) {
        unsafe {
            let _ = UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                Value: self.address.as_ptr().cast(),
            });
            let _ = CloseHandle(self.handle);
        }
    }
}
fn map(handle: HANDLE) -> Result<Arc<View>> {
    let address = unsafe { MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, size_of::<Shared>()) };
    let Some(address) = NonNull::new(address.Value.cast::<Shared>()) else {
        unsafe {
            let _ = CloseHandle(handle);
        }
        return Err(anyhow!("共有メモリをマップできません"));
    };
    Ok(Arc::new(View { handle, address }))
}
fn valid_rate(rate: u32) -> bool {
    (8_000..=192_000).contains(&rate)
}
fn wide(name: &str) -> Vec<u16> {
    name.encode_utf16().chain(std::iter::once(0)).collect()
}
fn valid_name(name: &str) -> bool {
    let Some(suffix) = name.strip_prefix(PREFIX) else {
        return false;
    };
    suffix.len() == 36
        && suffix.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
pub struct Mapping {
    view: Arc<View>,
    descriptor: Descriptor,
}
impl Mapping {
    pub fn create(rate: u32) -> Result<Self> {
        ensure!(valid_rate(rate), "共有メモリのサンプルレートが不正です");
        let guid = unsafe { CoCreateGuid()? };
        let name = format!("{PREFIX}{guid:?}");
        ensure!(valid_name(&name), "共有メモリ名の生成に失敗しました");
        let encoded = wide(&name);
        let handle = unsafe {
            CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                None,
                PAGE_READWRITE,
                0,
                size_of::<Shared>() as u32,
                PCWSTR(encoded.as_ptr()),
            )?
        };
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe {
                let _ = CloseHandle(handle);
            }
            return Err(anyhow!("共有メモリ名が既に存在します"));
        }
        let view = map(handle)?;
        unsafe {
            view.address.as_ptr().write(Shared::new(rate));
        }
        view.shared().ready.store(1, Ordering::Release);
        Ok(Self {
            view,
            descriptor: Descriptor {
                name,
                sample_rate: rate,
                protocol: PROTOCOL,
            },
        })
    }
    pub fn open(descriptor: &Descriptor) -> Result<Self> {
        ensure!(
            valid_name(&descriptor.name)
                && valid_rate(descriptor.sample_rate)
                && descriptor.protocol == PROTOCOL,
            "共有メモリの指定が不正です"
        );
        let encoded = wide(&descriptor.name);
        let handle =
            unsafe { OpenFileMappingW(FILE_MAP_ALL_ACCESS.0, false, PCWSTR(encoded.as_ptr()))? };
        let view = map(handle)?;
        let shared = view.shared();
        ensure!(
            shared.ready.load(Ordering::Acquire) == 1
                && shared.magic == MAGIC
                && shared.protocol == PROTOCOL
                && shared.rate == descriptor.sample_rate
                && shared.size as usize == size_of::<Shared>(),
            "共有メモリのヘッダーが不正です"
        );
        Ok(Self {
            view,
            descriptor: descriptor.clone(),
        })
    }
    pub fn descriptor(&self) -> Descriptor {
        self.descriptor.clone()
    }
    pub fn client(&mut self) -> Result<ClientPort> {
        self.view
            .shared()
            .client_claim
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| anyhow!("クライアントは既に取得済みです"))?;
        Ok(ClientPort {
            view: Arc::clone(&self.view),
        })
    }
    pub fn into_worker(self) -> Result<WorkerPort> {
        self.view
            .shared()
            .worker_claim
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| anyhow!("ワーカーは既に取得済みです"))?;
        Ok(WorkerPort { view: self.view })
    }
    pub fn failed(&self) -> bool {
        self.view.shared().failed.load(Ordering::Acquire) != 0
    }
    pub fn ready(&self) -> bool {
        self.view.shared().worker_ready.load(Ordering::Acquire) != 0
    }
    pub fn plugin_latency_frames(&self) -> Option<u32> {
        u32::try_from(self.view.shared().latency.load(Ordering::Acquire)).ok()
    }
    pub fn set_failed(&self) {
        self.view.shared().failed.store(1, Ordering::Release);
    }
}
pub struct ClientPort {
    view: Arc<View>,
}
impl ClientPort {
    pub fn try_input(&mut self, packet: &Packet) -> bool {
        self.view.shared().input.push(packet)
    }
    pub fn try_output(&mut self, packet: &mut Packet) -> bool {
        self.view.shared().output.pop(packet)
    }
    pub fn failed(&self) -> bool {
        self.view.shared().failed.load(Ordering::Acquire) != 0
    }
    pub fn set_failed(&self) {
        self.view.shared().failed.store(1, Ordering::Release);
    }
}
pub struct WorkerPort {
    view: Arc<View>,
}
impl WorkerPort {
    pub fn try_input(&mut self, packet: &mut Packet) -> bool {
        self.view.shared().input.pop(packet)
    }
    pub fn try_output(&mut self, packet: &Packet) -> bool {
        self.view.shared().output.push(packet)
    }
    pub fn failed(&self) -> bool {
        self.view.shared().failed.load(Ordering::Acquire) != 0
    }
    pub fn set_failed(&self) {
        self.view.shared().failed.store(1, Ordering::Release);
    }
    pub fn set_latency(&self, latency_frames: Option<u32>) {
        self.view.shared().latency.store(
            latency_frames.map_or(u64::MAX, u64::from),
            Ordering::Release,
        );
    }
    pub fn set_ready(&self, latency_frames: Option<u32>) {
        self.set_latency(latency_frames);
        self.view.shared().worker_ready.store(1, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separate_views_roundtrip_and_bounded_queue() {
        let mut owner = Mapping::create(48_000).unwrap();
        let descriptor = owner.descriptor();
        let mut worker = Mapping::open(&descriptor).unwrap().into_worker().unwrap();
        let mut client = owner.client().unwrap();
        assert!(Mapping::open(&descriptor).unwrap().client().is_err());
        let mut packet = Packet::default();
        packet.samples[0] = [1.5, -1.5];
        for sequence in 0..CAPACITY {
            packet.sequence = sequence;
            assert!(client.try_input(&packet));
        }
        assert!(!client.try_input(&packet));
        for sequence in 0..CAPACITY {
            let mut received = Packet::default();
            assert!(worker.try_input(&mut received));
            assert_eq!(received.sequence, sequence);
            assert_eq!(received.samples[0], [1.5, -1.5]);
            assert!(worker.try_output(&received));
        }
        assert!(!worker.try_output(&packet));
        for sequence in 0..CAPACITY {
            assert!(client.try_output(&mut packet));
            assert_eq!(packet.sequence, sequence);
        }
        assert!(!client.try_output(&mut packet));
    }
}
