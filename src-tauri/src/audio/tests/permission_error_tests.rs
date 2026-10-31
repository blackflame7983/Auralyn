
use super::localize_audio_error;

#[test]
fn access_denied_in_both_languages_and_hresult_has_permission_guidance() {
    for error in [
        "Input Stream Build Failed: Access is denied.",
        "アクセスが拒否されました。(0x80070005)",
        "Input Stream Build Failed: HRESULT 0x80070005",
    ] {
        let message = localize_audio_error(error.to_owned());
        assert!(message.contains("Store・MSIX版"));
        assert!(message.contains("デスクトップアプリの許可"));
        assert!(message.contains("他のアプリを閉じて"));
    }
}

#[test]
fn unrelated_audio_errors_do_not_claim_a_permission_denial() {
    let message = localize_audio_error("buffer allocation failed".to_owned());
    assert!(!message.contains("アクセスが拒否"));
    assert!(message.contains("buffer allocation failed"));
}
