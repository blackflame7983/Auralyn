//! サイドカー終了をホスト寿命に結びつけるWindows Job Object。
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub struct Job(HANDLE);

// SAFETY: Job は OS ハンドルを所有し、移動してもハンドルの所有権は変わらない。
unsafe impl Send for Job {}
// SAFETY: 共有操作は OS の Job API に委ね、ハンドルは最後の所有者の Drop で閉じる。
unsafe impl Sync for Job {}

impl Job {
    pub fn new_kill_on_drop() -> Option<Self> {
        // SAFETY: 新規 Job のハンドルを所有し、設定構造体は指定サイズで呼び出し中生存する。
        unsafe {
            let job = Self(CreateJobObjectW(None, None).ok()?);

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .ok()?;

            Some(job)
        }
    }

    pub fn assign(&self, process: HANDLE) -> bool {
        // SAFETY: self が Job を保持し、呼び出し元は生存中の Child のハンドルを渡す。
        unsafe { AssignProcessToJobObject(self.0, process).is_ok() }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: この Job が所有するハンドルを最後の参照の破棄時に一度だけ閉じる。
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
