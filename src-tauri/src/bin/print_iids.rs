use vst3::Interface;
use vst3::Steinberg::Vst::IContextMenu;
use vst3::Steinberg::Vst::IParameterFinder;

fn main() {
    // IID is [u8; 16]
    let iid_ctx = IContextMenu::IID;
    print!("IContextMenu: ");
    for b in iid_ctx {
        print!("0x{:02X}, ", b);
    }
    println!();

    let iid_param = IParameterFinder::IID;
    print!("IParameterFinder: ");
    for b in iid_param {
        print!("0x{:02X}, ", b);
    }
    println!();
}
