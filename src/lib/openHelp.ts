export const helpSectionKey = 'auralyn_help_section';
export const openHelpEvent = 'auralyn-open-help';

// 使い方を、指定した節で開く。開く側は保存した節を読んでから出す。
export function requestHelpSection(section: string) {
    try { localStorage.setItem(helpSectionKey, section); } catch { /* 保存できなくても、開く操作は続ける。 */ }
    window.dispatchEvent(new CustomEvent(openHelpEvent));
}
