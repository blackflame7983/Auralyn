import { useLayoutEffect, useRef } from 'react';
import { Toaster } from 'sonner';

export function NoticeLane() {
  const lane = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = lane.current;
    if (!root) return;
    const apply = () => {
      const toaster = root.querySelector<HTMLElement>('[data-sonner-toaster]');
      const height = toaster?.style.getPropertyValue('--front-toast-height').trim() || '0px';
      root.style.minHeight = height;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, []);
  const light = document.documentElement.classList.contains('light');
  return (
    <div ref={lane} className="notice-lane relative z-40 shrink-0">
      <Toaster position="top-center" offset={0} theme={light ? 'light' : 'dark'} richColors />
    </div>
  );
}
