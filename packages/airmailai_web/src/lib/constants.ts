export type {
    ModelOption,
    ModelParams,
    ModelTier,
    ModelTierAssignment,
    ProviderOption,
    ThinkingLevel,
    VisibleModelTier,
} from './models';
export {
    buildOpenRouterProvider,
    defaultModelForProvider,
    filterProvidersByTier,
    MODEL_TIERS,
    modelHasTier,
    modelMatchesTier,
    PROVIDERS,
    visibleModelTier,
} from './models';

export const MIN_EXT_VERSION = '26.8.24.1';

export const FONT_SIZES = [14, 16, 18, 20, 22, 24] as const;

export const THEMES: ReadonlyArray<{ id: string; name: string }> = [
    { id: 'airmail-warm', name: 'Airmail Warm' },
    { id: 'airmail-light', name: 'Airmail Light' },
    { id: 'absolutely', name: 'Absolutely' },
    { id: 'tapestry', name: 'Tapestry' },
    { id: 'solarized-light', name: 'Solarized Light' },
    { id: 'solarized-dark', name: 'Solarized Dark' },
    { id: 'phosphor', name: 'Phosphor' },
    { id: 'digital-rain', name: 'Digital Rain' },
    { id: 'dial-up', name: 'Dial-up' },
    { id: 'hotdog', name: 'Hotdog' },
];
