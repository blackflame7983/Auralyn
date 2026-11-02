//! 専用取得スレッドのCOM apartmentとkernel handle。
use anyhow::{bail, ensure, Result};
use std::time::Duration;
use windows::{
    core::PWSTR,
    Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::{
            Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
            Threading::{
                CreateEventW, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, SetEvent,
                WaitForMultipleObjects, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
                PROCESS_SYNCHRONIZE,
            },
        },
    },
};

pub struct Apartment;
impl Apartment {
    pub fn new() -> Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub struct Handle(pub HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

pub struct Event(Handle);
// kernel eventはスレッド間でSetEvent/Waitできる。Arcの最後の所有者だけがCloseする。
unsafe impl Send for Event {}
unsafe impl Sync for Event {}
impl Event {
    pub fn new(manual_reset: bool) -> Result<Self> {
        Ok(Self(Handle(unsafe {
            CreateEventW(None, manual_reset, false, None)?
        })))
    }
    pub fn raw(&self) -> HANDLE {
        self.0 .0
    }
    pub fn signal(&self) -> Result<()> {
        unsafe { SetEvent(self.raw())? };
        Ok(())
    }
}

pub fn wait(handles: &[HANDLE], duration: Duration) -> Result<Option<usize>> {
    ensure!(
        !handles.is_empty() && handles.len() <= 64,
        "待機対象数が不正です"
    );
    let timeout = duration.as_millis().min(u128::from(u32::MAX - 1)) as u32;
    let result = unsafe { WaitForMultipleObjects(handles, false, timeout) };
    if result == WAIT_TIMEOUT {
        return Ok(None);
    }
    let index = result.0.wrapping_sub(WAIT_OBJECT_0.0) as usize;
    if index < handles.len() {
        Ok(Some(index))
    } else {
        bail!("kernel eventの待機に失敗しました: 0x{:08x}", result.0)
    }
}

pub struct Process {
    pub pid: u32,
    pub created: u64,
    pub handle: Handle,
}

impl Process {
    pub fn open(pid: u32) -> Result<Self> {
        ensure!(pid != 0, "PID 0は対象にできません");
        let handle = Handle(unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                pid,
            )?
        });
        let mut created = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        unsafe { GetProcessTimes(handle.0, &mut created, &mut exit, &mut kernel, &mut user)? };
        ensure!(
            exit.dwHighDateTime == 0 && exit.dwLowDateTime == 0,
            "対象は終了しています"
        );
        Ok(Self {
            pid,
            created: (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime),
            handle,
        })
    }
    pub fn image(&self) -> Result<String> {
        let mut buffer = vec![0u16; 32_768];
        let mut length = buffer.len() as u32;
        unsafe {
            QueryFullProcessImageNameW(
                self.handle.0,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )?;
        }
        Ok(String::from_utf16(&buffer[..length as usize])?)
    }
    pub fn verify(&self, expected: u64) -> Result<()> {
        ensure!(
            expected == self.created,
            "対象の生成時刻が変わりました。選び直してください"
        );
        ensure!(
            wait(&[self.handle.0], Duration::ZERO)?.is_none(),
            "対象は終了しています"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creation_time_is_required_and_signalled_stop_is_observable() {
        assert!(Process::open(0).is_err());
        let process = Process::open(std::process::id()).unwrap();
        assert!(process.verify(process.created).is_ok());
        assert!(process.verify(process.created.wrapping_add(1)).is_err());
        let event = Event::new(true).unwrap();
        assert_eq!(wait(&[event.raw()], Duration::ZERO).unwrap(), None);
        event.signal().unwrap();
        assert_eq!(
            wait(&[event.raw()], Duration::from_millis(10)).unwrap(),
            Some(0)
        );
    }
}
