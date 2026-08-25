function isProviderFileNotFound(error: unknown): boolean {
    return error instanceof Error && 'status' in error && error.status === 404;
}

export async function deleteProviderFileIfPresent(
    deleteFile: () => Promise<void>
): Promise<void> {
    try {
        await deleteFile();
    } catch (error) {
        if (!isProviderFileNotFound(error)) throw error;
    }
}
