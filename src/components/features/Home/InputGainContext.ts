import { createContext } from 'react';

// Portal内の音量操作も、ホームや大型メーターが背後に隠れる状態を共有する。
export const InputGainDisabledContext = createContext(false);
