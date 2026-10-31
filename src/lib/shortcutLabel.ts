const modifierNames: Record<string, string> = { control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', super: 'Windows', meta: 'Windows' };
const keyNames: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };

/** 保存値（KeyboardEvent.code 形式）を、キーボードの刻印に近い表記へ変える。保存値は変えない。 */
export function formatShortcut(value: string): string {
    if (!value) return '';
    const parts = value.split('+');
    const key = parts.pop() ?? '';
    const name = /^Key[A-Z]$/.test(key) ? key.slice(3) : /^Digit[0-9]$/.test(key) ? key.slice(5) : keyNames[key] ?? key;
    return [...parts.map(part => modifierNames[part.toLowerCase()] ?? part), name].filter(Boolean).join(' + ');
}
