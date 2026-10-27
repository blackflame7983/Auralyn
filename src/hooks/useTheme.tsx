import React, { createContext, useContext, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

type Theme = 'light' | 'dark' | 'gaming';

interface ThemeContextType {
    theme: Theme;
    setTheme: (theme: Theme) => void;
    toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [theme, setTheme] = useState<Theme>(() => {
        // Check localStorage
        let saved: string | null = null;
        try { saved = localStorage.getItem('vst_host_theme'); } catch { /* 保存先を利用できないときは OS の設定を使う。 */ }
        if (saved === 'light' || saved === 'dark' || saved === 'gaming') return saved as Theme;
        // Check System Preference
        try {
            if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
        } catch { /* OS の設定を読めないときはダークを使う。 */ }
        return 'dark'; // Default to dark
    });

    useEffect(() => {
        const root = window.document.documentElement;
        // Clean up
        root.classList.remove('light', 'dark', 'gaming');

        if (theme === 'gaming') {
            root.classList.add('dark', 'gaming');
            getCurrentWindow().setTheme('dark').catch(console.error);
        } else if (theme === 'dark') {
            root.classList.add('dark');
            getCurrentWindow().setTheme('dark').catch(console.error);
        } else {
            root.classList.add('light');
            getCurrentWindow().setTheme('light').catch(console.error);
        }
        try { localStorage.setItem('vst_host_theme', theme); } catch { /* 表示の切り替えは保存できなくても維持する。 */ }
    }, [theme]);

    const toggleTheme = () => {
        setTheme(prev => {
            if (prev === 'light') return 'dark';
            if (prev === 'dark') return 'gaming';
            return 'light';
        });
    };

    return (
        <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
            {children}
        </ThemeContext.Provider>
    );
};

export const useTheme = () => {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
};
