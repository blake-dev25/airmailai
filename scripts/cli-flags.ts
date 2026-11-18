export function assertKnownFlags(
    args: readonly string[],
    known: readonly string[]
): void {
    const unknown = args.filter(
        (arg) => arg.startsWith('--') && !known.includes(arg)
    );
    if (unknown.length > 0) {
        throw new Error(
            `Unknown flag(s): ${unknown.join(', ')}. Known flags: ${known.join(', ')}`
        );
    }
}

export function flagValue(
    args: readonly string[],
    flag: string,
    offset = 1
): string | undefined {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const value = args[index + offset];
    if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} is missing a value`);
    }
    return value;
}
