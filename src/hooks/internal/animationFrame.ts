export function startAnimationFrames(onFrame: (time: number) => void): () => void {
    let active = true;
    let frame: number;
    const tick = (time: number) => {
        if (!active) return;
        onFrame(time);
        if (active) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { active = false; cancelAnimationFrame(frame); };
}
