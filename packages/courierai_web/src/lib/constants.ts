export type {
    ModelOption,
    ModelParams,
    ModelTier,
    ProviderOption,
    ThinkingLevel,
} from './models';
export {
    buildOpenRouterProvider,
    filterProvidersByTier,
    MODEL_TIERS,
    modelMatchesTier,
    PROVIDERS,
} from './models';

export const FONT_SIZES = [14, 16, 18, 20, 22, 24] as const;

export const THEMES: ReadonlyArray<{ id: string; name: string }> = [
    { id: 'airmail-warm', name: 'Airmail Warm' },
    { id: 'airmail-light', name: 'Airmail Light' },
    { id: 'absolutely', name: 'Absolutely' },
    { id: 'tapestry', name: 'Tapestry' },
    { id: 'solarized-light', name: 'Solarized Light' },
    { id: 'solarized-dark', name: 'Solarized Dark' },
    { id: 'retro-sci-fi-hud', name: 'Retro Sci-Fi HUD' },
    { id: 'digital-rain', name: 'Digital Rain' },
];
