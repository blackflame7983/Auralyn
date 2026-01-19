use vst3::Interface;
use vst3::Steinberg::Vst::*;
use vst3::Steinberg::*;

fn print_iid<T: Interface>(name: &str) {
    let t = T::IID;
    println!("{}: {:02X?}{:02X?}{:02X?}{:02X?}-{:02X?}{:02X?}-{:02X?}{:02X?}-{:02X?}{:02X?}-{:02X?}{:02X?}{:02X?}{:02X?}{:02X?}{:02X?}",
        name,
        t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7],
        t[8], t[9], t[10], t[11], t[12], t[13], t[14], t[15]
    );
}

fn main() {
    println!("Printing VST3 Interface UUIDs...");

    // IPlugFrame: Frame of the view (resizing)
    print_iid::<IPlugFrame>("IPlugFrame");

    // IPlugViewContentScaleSupport: High-DPI support
    print_iid::<IPlugViewContentScaleSupport>("IPlugViewContentScaleSupport");

    // IHostApplication: Host Name etc.
    print_iid::<IHostApplication>("IHostApplication");

    // IComponentHandler
    print_iid::<IComponentHandler>("IComponentHandler");
    print_iid::<IComponentHandler2>("IComponentHandler2");

    // Units
    print_iid::<IUnitHandler>("IUnitHandler");
    print_iid::<IUnitInfo>("IUnitInfo");

    // Context Menu
    print_iid::<IContextMenu>("IContextMenu");

    // Others
    print_iid::<IAttributeList>("IAttributeList");
    print_iid::<IMessage>("IMessage");
    print_iid::<IConnectionPoint>("IConnectionPoint");
    print_iid::<IParameterChanges>("IParameterChanges");
    print_iid::<IParamValueQueue>("IParamValueQueue");
}
