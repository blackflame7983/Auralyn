import type { Page } from '@playwright/test';

// Windows の実行環境では、多くのページを開くと、ソケットの一時的な不足（WSAENOBUFS）で
// ナビゲーションそのものが失敗することがある（#643）。画面の不具合ではないので、この失敗だけを
// 間を置いて開き直す。ほかの失敗は再試行で隠さない（playwright.config.ts の retries: 0）。
export const transientNavigationError = 'net::ERR_NO_BUFFER_SPACE';
// 失敗した遷移のエラーページでは、初期化スクリプトの localStorage が拒否される。
export const deniedStorageOnErrorPage = "Failed to read the 'localStorage' property from 'Window': Access is denied for this document.";

/**
 * page.goto を包み、一時的なソケット不足のときだけ最大3回開き直す。
 * errors を渡すと、失敗した遷移の間に積まれた例外を取り除く。
 * 戻り値は、これまでに開き直した回数を返す関数。
 */
export function retryTransientNavigation(page: Page, errors?: string[]): () => number {
    let retries = 0;
    const goto = page.goto.bind(page);
    page.goto = async (url, options) => {
        for (let attempt = 0; ; attempt += 1) {
            const before = errors?.length ?? 0;
            try {
                return await goto(url, options);
            } catch (error) {
                if (attempt >= 3 || !String(error).includes(transientNavigationError)) throw error;
                retries += 1;
                await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
                errors?.splice(before);
            }
        }
    };
    return () => retries;
}
