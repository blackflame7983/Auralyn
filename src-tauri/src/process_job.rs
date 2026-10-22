//! サイドカー終了をホスト寿命に結びつけるWindows Job Object。
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub struct Job(HANDLE);

// HANDLE is just an OS handle; it is safe to move/share as an opaque value as long as
// we don't use it concurrently in a data-race way (we only close on Drop).
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    pub fn new_kill_on_drop() -> Option<Self> {
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
        unsafe { AssignProcessToJobObject(self.0, process).is_ok() }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
