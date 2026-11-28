use std::hint::black_box;

pub const FRAME_SIZE: usize = nnnoiseless::DenoiseState::FRAME_SIZE;
pub type Frame = [f32; FRAME_SIZE];
pub const KINDS: [&str; 6] = ["silence", "tiny", "sine", "noise", "impulse", "square"];

pub fn configuration() -> Result<(), Box<dyn std::error::Error>> {
    if cfg!(debug_assertions) || !cfg!(panic = "abort") || cfg!(feature = "dsp-verification") {
        return Err("release・panic=abort・検証feature無効の構成が必要です".into());
    }
    Ok(())
}

pub fn input(kind: usize, frame: usize) -> Frame {
    std::array::from_fn(|i| {
        let n = frame * FRAME_SIZE + i;
        match kind {
            0 => 0.0,
            1 => 0.001,
            2 => (n as f32 * 0.071).sin() * 20_000.0,
            3 => ((n * 13 % 107) as f32 - 53.0) * 400.0,
            4 => {
                if n.is_multiple_of(199) {
                    32_767.0
                } else {
                    0.0
                }
            }
            _ => {
                if n % 101 < 50 {
                    32_767.0
                } else {
                    -32_768.0
                }
            }
        }
    })
}

pub trait Dsp: Send + 'static {
    fn new() -> Self;
    fn process(&mut self, output: &mut Frame, input: &Frame) -> f32;
    fn reset(&mut self);
    fn state_size() -> usize;
}

pub struct Current(Box<nnnoiseless::DenoiseState<'static>>);
pub struct Registry(Box<nnnoiseless_reference::DenoiseState<'static>>);

impl Dsp for Current {
    fn new() -> Self {
        Self(nnnoiseless::DenoiseState::new())
    }
    fn process(&mut self, output: &mut Frame, input: &Frame) -> f32 {
        self.0.process_frame(output, input)
    }
    fn reset(&mut self) {
        self.0.reset();
    }
    fn state_size() -> usize {
        std::mem::size_of::<nnnoiseless::DenoiseState<'static>>()
    }
}

impl Dsp for Registry {
    fn new() -> Self {
        Self(nnnoiseless_reference::DenoiseState::new())
    }
    fn process(&mut self, output: &mut Frame, input: &Frame) -> f32 {
        self.0.process_frame(output, input)
    }
    // 旧エンジンのresetと同じ、新品の構築と旧Boxの破棄を含む置換。
    fn reset(&mut self) {
        self.0 = nnnoiseless_reference::DenoiseState::new();
    }
    fn state_size() -> usize {
        std::mem::size_of::<nnnoiseless_reference::DenoiseState<'static>>()
    }
}

pub fn hash(vad: f32, output: &Frame) -> u64 {
    std::iter::once(vad)
        .chain(output.iter().copied())
        .fold(0xcbf29ce484222325, |h, value| {
            value.to_bits().to_le_bytes().iter().fold(h, |h, byte| {
                (h ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
            })
        })
}

pub fn validate() {
    for kind in 0..KINDS.len() {
        let (mut a, mut b) = (Current::new(), Registry::new());
        let (mut x, mut y) = ([0.0; FRAME_SIZE], [0.0; FRAME_SIZE]);
        for reset in 0..2 {
            if reset != 0 {
                a.reset();
                b.reset();
            }
            for n in 0..64 {
                let frame = input(kind, n);
                let av = a.process(&mut x, &frame);
                let bv = b.process(&mut y, &frame);
                assert_eq!(av.to_bits(), bv.to_bits());
                assert!(x.iter().zip(y).all(|(x, y)| x.to_bits() == y.to_bits()));
                black_box((&x, &y));
            }
        }
    }
}
