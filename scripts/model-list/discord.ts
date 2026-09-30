import { discordWebhookUrl } from './env';
import { errorMessage, httpRequest } from './http';
import type { Provider } from './shared';
import type { UpdateReport } from './update';
import { ALL_PROVIDERS } from './update';
import type { WatcherReport } from './watcher';

export interface DiscordEmbed {
    title: string;
    description: string;
    color: number;
}

const PROVIDER_COLORS: Record<Provider, number> = {
    anthropic: 0xcc785c,
    openai: 0x10a37f,
    google: 0x4285f4,
};
const PROVIDER_LABELS: Record<Provider, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
};
const COLOR_ERROR = 0xed4245;
const COLOR_OK = 0x57f287;
const EMBEDS_PER_MESSAGE = 10;
const DESCRIPTION_LIMIT = 4000;
const MESSAGE_CHARACTER_LIMIT = 6000;

export function batchDiscordEmbeds(embeds: DiscordEmbed[]): DiscordEmbed[][] {
    const batches: DiscordEmbed[][] = [];
    let batch: DiscordEmbed[] = [];
    let characters = 0;
    for (const embed of embeds) {
        const length = embed.title.length + embed.description.length;
        if (
            embed.title.length > 256 ||
            embed.description.length > 4096 ||
            length > MESSAGE_CHARACTER_LIMIT
        ) {
            throw new Error(
                `Discord embed exceeds character limits: ${embed.title.slice(0, 256)}`
            );
        }
        if (
            batch.length === EMBEDS_PER_MESSAGE ||
            characters + length > MESSAGE_CHARACTER_LIMIT
        ) {
            batches.push(batch);
            batch = [];
            characters = 0;
        }
        batch.push(embed);
        characters += length;
    }
    if (batch.length > 0) batches.push(batch);
    return batches;
}

function codeBlock(text: string): string {
    const body =
        text.length > DESCRIPTION_LIMIT
            ? text.slice(0, DESCRIPTION_LIMIT - 4) + '\n...'
            : text;
    return '```\n' + body + '\n```';
}

export async function postDiscord(
    webhookUrl: string,
    embeds: DiscordEmbed[]
): Promise<void> {
    for (const batch of batchDiscordEmbeds(embeds)) {
        const { status, text } = await httpRequest({
            url: webhookUrl,
            label: 'Discord webhook',
            method: 'POST',
            headers: {
                'User-Agent':
                    'DiscordBot (https://github.com/blake-dev25, 0.1)',
            },
            body: { embeds: batch },
        });
        if (status < 200 || status >= 300) {
            throw new Error(
                `HTTP ${status} posting to Discord: ${text.slice(0, 500)}`
            );
        }
    }
}

export async function notify(embeds: DiscordEmbed[]): Promise<void> {
    if (embeds.length === 0) return;
    const url = discordWebhookUrl();
    if (!url) {
        console.log(
            `no AIRMAILAI_DISCORD_WEBHOOK_URL - skipping ${embeds.length} Discord embed(s)`
        );
        return;
    }
    await postDiscord(url, embeds);
    console.log(`posted ${embeds.length} embed(s) to Discord`);
}

export async function notifyCrash(what: string, e: unknown): Promise<void> {
    try {
        await notify([
            {
                title: `${what} crashed`,
                description: codeBlock(errorMessage(e)),
                color: COLOR_ERROR,
            },
        ]);
    } catch (notifyError) {
        console.log(`Discord notify failed: ${errorMessage(notifyError)}`);
    }
}

export function watcherEmbeds(report: WatcherReport): DiscordEmbed[] {
    const embeds: DiscordEmbed[] = [];
    for (const provider of ALL_PROVIDERS) {
        const label = PROVIDER_LABELS[provider];
        const error = report.errors[provider];
        if (error) {
            embeds.push({
                title: `${label} fetch failed`,
                description: codeBlock(error),
                color: COLOR_ERROR,
            });
            continue;
        }
        const fresh = report.newIds[provider] ?? [];
        if (fresh.length === 0) continue;
        embeds.push({
            title: `New ${label} models (${fresh.length})`,
            description: codeBlock(fresh.join('\n')),
            color: PROVIDER_COLORS[provider],
        });
    }
    return embeds;
}

function section(header: string, ids: string[]): string[] {
    if (ids.length === 0) return [];
    return [`${header}\n${ids.map((id) => `  ${id}`).join('\n')}`];
}

export function updateEmbeds(
    report: UpdateReport,
    source: string
): DiscordEmbed[] {
    const embeds: DiscordEmbed[] = [];
    for (const o of report.outcomes) {
        const label = PROVIDER_LABELS[o.provider];
        if (o.status === 'failed') {
            embeds.push({
                title: `${label} update failed - kept previous ${o.modelCount} model(s)`,
                description: codeBlock(o.error ?? 'unknown error'),
                color: COLOR_ERROR,
            });
            continue;
        }
        const parts = [
            ...section(`added (${o.added.length}):`, o.added),
            ...section(`changed (${o.changed.length}):`, o.changed),
            ...section(
                `kept but no longer listed (${o.unlisted.length}):`,
                o.unlisted
            ),
            ...o.warnings.map((w) => `WARN ${w}`),
        ];
        embeds.push({
            title: `${label}: ${o.modelCount} models (+${o.added.length} added, ${o.changed.length} changed)`,
            description: codeBlock(
                parts.length > 0 ? parts.join('\n\n') : 'no changes'
            ),
            color: PROVIDER_COLORS[o.provider],
        });
    }
    const failed = report.outcomes.some((o) => o.status === 'failed');
    const verb = report.dryRun ? 'would write' : 'wrote';
    embeds.push({
        title: report.dryRun
            ? `models.json dry run (${source})`
            : report.written.length > 0
              ? `models.json published (${source})`
              : `models.json unchanged (${source})`,
        description: codeBlock(
            [
                `generatedAt ${report.generatedAt}`,
                ...report.written.map((t) => `${verb} ${t}`),
                ...report.unchanged.map((t) => `unchanged ${t}`),
                ...ALL_PROVIDERS.flatMap((provider) =>
                    section(
                        `${provider} explicitly retired:`,
                        report.retired[provider] ?? []
                    )
                ),
            ].join('\n')
        ),
        color: failed ? COLOR_ERROR : COLOR_OK,
    });
    return embeds;
}
