export type ExtensionPromptVariant =
    'no-extension' | 'unsupported-browser' | 'mobile';

export type ExtensionMode =
    | { kind: 'detecting' }
    | { kind: 'connected' }
    | { kind: 'missing'; variant: ExtensionPromptVariant }
    | {
          kind: 'demo';
          variant: ExtensionPromptVariant;
          promptOpen: boolean;
      };

class AppMode {
    extension = $state<ExtensionMode>({ kind: 'detecting' });
    isDemo = $derived(this.extension.kind === 'demo');
    extensionPrompt = $derived<ExtensionPromptVariant | null>(
        this.extension.kind === 'missing' ||
            (this.extension.kind === 'demo' && this.extension.promptOpen)
            ? this.extension.variant
            : null
    );
}

export const appMode = new AppMode();
