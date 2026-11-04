import { MdCast, MdHearing, MdSettings } from 'react-icons/md';
import { DiscordIcon } from '@/components/ui/DiscordIcon';

// ホームとセットアップで表示順・名前・アイコンを共有する。
export const destinationChoices = [
    { value: 'obs', label: 'prep.obs', icon: MdCast, hint: 'wizard.obsHint' },
    { value: 'discord', label: 'prep.call', icon: DiscordIcon, hint: 'wizard.chatHint' },
    { value: 'listening', label: 'prep.local', icon: MdHearing, hint: 'wizard.listeningHint' },
    { value: 'other', label: 'prep.other', icon: MdSettings, hint: 'guide.copy.181' },
] as const;
