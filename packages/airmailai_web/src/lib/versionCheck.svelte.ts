import { MIN_EXT_VERSION } from './constants';
import { log } from './log';

const WEB_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function versionLessThan(a: string, b: string): boolean {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
        if (diff !== 0) return diff < 0;
    }
    return false;
}

export interface UpdateNotice {
    message: string;
    refresh: boolean;
}

class VersionCheck {
    private webUpdateAvailable = $state(false);
    private extStatus = $state<'ok' | 'outdated' | 'updated'>('ok');
    private lastWebCheckAt = Date.now();
    private knownExtVersion: string | null = null;

    notice: UpdateNotice | null = $derived.by(() => {
        if (this.extStatus === 'updated') {
            return {
                message:
                    'The AirmailAI extension just updated. Refresh to reconnect.',
                refresh: true,
            };
        }
        if (this.webUpdateAvailable) {
            return {
                message:
                    'A new version of AirmailAI is available. Refresh to get it.',
                refresh: true,
            };
        }
        if (this.extStatus === 'outdated') {
            return {
                message:
                    'An AirmailAI extension update is rolling out. Chrome will install it automatically within a few hours, or restart your browser to get it now.',
                refresh: false,
            };
        }
        return null;
    });

    dismiss(): void {
        this.webUpdateAvailable = false;
        this.extStatus = 'ok';
    }

    checkExtAtStartup(
        version: string | null,
        versionName: string | null
    ): void {
        this.knownExtVersion = version;
        if (window.location.hostname !== 'airmailai.net') return;
        const outdated = !version || versionLessThan(version, MIN_EXT_VERSION);
        if (!outdated) return;
        if (versionName?.includes('-local')) {
            log.warn('local extension build older than MIN_EXT_VERSION', {
                version,
                versionName,
                min: MIN_EXT_VERSION,
            });
            return;
        }
        log.warn('extension outdated', { version, min: MIN_EXT_VERSION });
        this.extStatus = 'outdated';
    }

    reportExtVersion(version: string): void {
        const changed =
            this.knownExtVersion !== null && this.knownExtVersion !== version;
        const outdatedResolved =
            this.extStatus === 'outdated' &&
            !versionLessThan(version, MIN_EXT_VERSION);
        this.knownExtVersion = version;
        if (changed || outdatedResolved) {
            log.info('extension updated mid-session', version);
            this.extStatus = 'updated';
        }
    }

    maybeCheckWebVersion(): void {
        if (this.webUpdateAvailable) return;
        if (Date.now() - this.lastWebCheckAt < WEB_CHECK_INTERVAL_MS) return;
        this.lastWebCheckAt = Date.now();
        void this.fetchWebVersion();
    }

    private async fetchWebVersion(): Promise<void> {
        try {
            const res = await fetch('/version.json', { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const { version } = (await res.json()) as { version?: unknown };
            if (typeof version !== 'string' || !version) {
                throw new Error('malformed version.json');
            }
            if (version !== __APP_VERSION__) {
                log.info('web update available', {
                    running: __APP_VERSION__,
                    latest: version,
                });
                this.webUpdateAvailable = true;
            }
        } catch (err) {
            log.warn('web version check failed', err);
        }
    }
}

export const versionCheck = new VersionCheck();
