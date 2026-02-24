import { Component, ErrorInfo, ReactNode } from 'react';
import { MdError, MdRefresh, MdBugReport } from 'react-icons/md';

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
    errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null, errorInfo: null };
    }

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        this.setState({ errorInfo });
        // Log to console for debugging (will be visible in DevTools)
        console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    }

    handleReload = () => {
        window.location.reload();
    };

    handleRecover = () => {
        this.setState({ hasError: false, error: null, errorInfo: null });
    };

    render() {
        if (this.state.hasError) {
            return (
                <div className="fixed inset-0 z-[99999] bg-background flex items-center justify-center p-8">
                    <div className="max-w-lg w-full space-y-6 text-center">
                        {/* Icon */}
                        <div className="mx-auto w-20 h-20 bg-destructive/10 rounded-full flex items-center justify-center">
                            <MdError className="w-10 h-10 text-destructive" />
                        </div>

                        {/* Message */}
                        <div className="space-y-2">
                            <h1 className="text-2xl font-bold text-foreground">
                                画面の表示中にエラーが発生しました
                            </h1>
                            <p className="text-muted-foreground leading-relaxed">
                                音声処理は引き続き動作しています。<br />
                                「復帰を試す」ボタンで元の画面に戻れる場合があります。
                            </p>
                        </div>

                        {/* Actions */}
                        <div className="flex flex-col sm:flex-row gap-3 justify-center">
                            <button
                                onClick={this.handleRecover}
                                className="flex items-center justify-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-bold rounded-xl hover:bg-primary/90 transition-colors shadow-lg"
                            >
                                <MdRefresh className="w-5 h-5" />
                                復帰を試す
                            </button>
                            <button
                                onClick={this.handleReload}
                                className="flex items-center justify-center gap-2 px-6 py-3 bg-muted text-foreground font-bold rounded-xl hover:bg-muted/80 transition-colors border border-border"
                            >
                                <MdRefresh className="w-5 h-5" />
                                画面をリロード
                            </button>
                        </div>

                        {/* Error Details (collapsible) */}
                        <details className="text-left bg-muted/50 rounded-lg border border-border p-4 text-xs">
                            <summary className="cursor-pointer text-muted-foreground font-bold flex items-center gap-2">
                                <MdBugReport className="w-4 h-4" />
                                エラーの詳細（開発者向け）
                            </summary>
                            <pre className="mt-3 p-3 bg-background rounded-md overflow-auto max-h-40 text-destructive font-mono whitespace-pre-wrap break-words">
                                {this.state.error?.toString()}
                                {'\n\n'}
                                {this.state.errorInfo?.componentStack}
                            </pre>
                        </details>

                        {/* Reassurance */}
                        <p className="text-[10px] text-muted-foreground/50">
                            ※ オーディオエンジンはバックグラウンドで動作を継続しています。配信中の音声には影響しません。
                        </p>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
