export type ProtoScreen = 'unset' | 'setup' | 'ready';
export interface ProtoScreenProps { screen: ProtoScreen; setScreen: (screen: ProtoScreen) => void }
