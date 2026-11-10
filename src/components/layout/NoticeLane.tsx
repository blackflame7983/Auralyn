import { useLayoutEffect, useRef } from 'react';
import { Toaster } from 'sonner';

const toastGap = 14;

export function NoticeLane() {
  const lane = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = lane.current;
    if (!root) return;
    const observed = new Set<HTMLElement>();
    const resize = new ResizeObserver(() => apply());
    const apply = () => {
      // 展開表示する通知すべての高さを予約する。退場中の通知もDOMから消えるまで含める。
      const toasts = [...root.querySelectorAll<HTMLElement>('[data-sonner-toast][data-visible="true"]')];
      for (const node of observed) {
        if (!toasts.includes(node)) { resize.unobserve(node); observed.delete(node); }
      }
      for (const node of toasts) {
        if (!observed.has(node)) { resize.observe(node); observed.add(node); }
      }
      const height = toasts.reduce((sum, node) => sum + node.offsetHeight, 0) + Math.max(0, toasts.length - 1) * toastGap;
      if (root.style.minHeight !== `${height}px`) root.style.minHeight = `${height}px`;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-visible'] });
    return () => { observer.disconnect(); resize.disconnect(); };
  }, []);
  const light = document.documentElement.classList.contains('light');
  return (
    <div ref={lane} className="notice-lane relative z-40 shrink-0">
      <Toaster position="top-center" offset={0} gap={toastGap} expand theme={light ? 'light' : 'dark'} richColors />
    </div>
  );
}
