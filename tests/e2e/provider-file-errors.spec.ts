import { expect, test } from '@playwright/test';
import { deleteProviderFileIfPresent } from '../../packages/airmailai_ext/providers/provider-file-errors';

test('provider file deletion accepts an already absent file', async () => {
    const error = Object.assign(new Error('No such file'), { status: 404 });

    await deleteProviderFileIfPresent(async () => {
        throw error;
    });
});

test('provider file deletion preserves other failures', async () => {
    const error = Object.assign(new Error('Provider unavailable'), {
        status: 503,
    });

    await expect(
        deleteProviderFileIfPresent(async () => {
            throw error;
        })
    ).rejects.toBe(error);
});
