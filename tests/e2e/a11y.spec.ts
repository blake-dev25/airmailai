import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';

test('main app has no serious/critical accessibility violations', async ({
    courierai,
}) => {
    await courierai.goto();

    const results = await new AxeBuilder({ page: courierai.page })
        .disableRules(['color-contrast'])
        .analyze();

    const seriousOrWorse = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical'
    );
    expect(
        seriousOrWorse,
        seriousOrWorse.map((v) => `${v.id}: ${v.help}`).join('\n')
    ).toEqual([]);
});
