export interface FenceState {
    char: '`' | '~';
    len: number;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

export function advanceFence(
    open: FenceState | null,
    line: string
): FenceState | null {
    const m = FENCE_RE.exec(line);
    if (!m) return open;
    const char = m[1][0] as FenceState['char'];
    const len = m[1].length;
    if (open) {
        if (char === open.char && len >= open.len && m[2].trim() === '') {
            return null;
        }
        return open;
    }
    if (char === '`' && m[2].includes('`')) return null;
    return { char, len };
}
