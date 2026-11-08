export const shortcutActions = {
    muteToggle: 'settings.ShortcutsPanel.363', bypassToggle: 'settings.ShortcutsPanel.366',
    singingOn: 'settings.ShortcutsPanel.371', talkOn: 'settings.ShortcutsPanel.372',
    muteOn: 'settings.ShortcutsPanel.364', muteOff: 'settings.ShortcutsPanel.365',
    bypassOn: 'settings.ShortcutsPanel.367', bypassOff: 'settings.ShortcutsPanel.368',
    gainUp: 'settings.ShortcutsPanel.369', gainDown: 'settings.ShortcutsPanel.370',
    noiseToggle: 'settings.ShortcutsPanel.393',
} as const;
export type ShortcutAction = keyof typeof shortcutActions;
