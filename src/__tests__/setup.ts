import '@testing-library/jest-dom';
import './setupTauri';

if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
        observe() {} unobserve() {} disconnect() {}
    };
}

if (!window.PointerEvent) {
    window.PointerEvent = class extends MouseEvent {
        pointerId: number;
        pointerType: string;
        constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0; this.pointerType = init.pointerType ?? 'mouse'; }
    } as typeof PointerEvent;
}
if (!HTMLElement.prototype.setPointerCapture) {
    const captured = new WeakMap<HTMLElement, number>();
    HTMLElement.prototype.setPointerCapture = function (id) { captured.set(this, id); };
    HTMLElement.prototype.hasPointerCapture = function (id) { return captured.get(this) === id; };
    HTMLElement.prototype.releasePointerCapture = function () { captured.delete(this); };
}
