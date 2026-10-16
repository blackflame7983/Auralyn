use crate::{Complex, FREQ_SIZE, WINDOW_SIZE};
use easyfft::dyn_size::realfft::DynRealDft;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::sync::Arc;

// easyfftと同じrealfftの計画・処理を使い、TLSではなくインスタンスが作業領域を所有する。
#[derive(Clone)]
pub(crate) struct FftWorkspace {
    forward: Arc<dyn RealToComplex<f32>>,
    inverse: Arc<dyn ComplexToReal<f32>>,
    input: Vec<f32>,
    spectrum: Vec<Complex>,
    scratch: Vec<Complex>,
}

impl FftWorkspace {
    pub(crate) fn new() -> Self {
        let mut planner = RealFftPlanner::new();
        let forward = planner.plan_fft_forward(WINDOW_SIZE);
        let inverse = planner.plan_fft_inverse(WINDOW_SIZE);
        let scratch_len = forward.get_scratch_len().max(inverse.get_scratch_len());
        Self {
            forward,
            inverse,
            input: vec![0.0; WINDOW_SIZE],
            spectrum: vec![Complex::default(); FREQ_SIZE],
            scratch: vec![Complex::default(); scratch_len],
        }
    }

    pub(crate) fn forward(&mut self, input: &[f32], output: &mut DynRealDft<f32>) {
        // FFTは入力を作業領域として使う。従来のeasyfft同様、入力をコピーして保持する。
        self.input.copy_from_slice(input);
        self.forward
            .process_with_scratch(&mut self.input, &mut self.spectrum, &mut self.scratch)
            .expect("構築済みFFTと固定長バッファのサイズは一致する");
        output.copy_from_slice(&self.spectrum);
    }

    pub(crate) fn inverse(&mut self, input: &DynRealDft<f32>, output: &mut [f32]) {
        self.spectrum.copy_from_slice(input);
        self.inverse
            .process_with_scratch(&mut self.spectrum, output, &mut self.scratch)
            .expect("構築済み逆FFTと固定長バッファのサイズは一致する");
    }

    pub(crate) fn reset(&mut self) {
        self.input.fill(0.0);
        self.spectrum.fill(Complex::default());
        self.scratch.fill(Complex::default());
    }
}
