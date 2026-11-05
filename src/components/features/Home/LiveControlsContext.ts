import { createContext } from 'react';

// 未設定のホームでは、歌・雑談の欄を状態の読み取りのために隠して置く（#297）。
// 隠れている間は、Portal へ出した小窓も開いたまま残さない。
export const LiveControlsHiddenContext = createContext(false);
