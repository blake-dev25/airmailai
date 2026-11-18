import {
    type AirmailAIMessage,
    type CustomModelConfig,
    type SiteChatMeta,
    errorMessage,
} from '@airmailai/shared';
import { messageText } from './types';
import {
    validateCustomModelConfig,
    validateModelIdLength,
} from './settingsValidation';

export type ChatExportFormat = 'md' | 'airmailai' | 'lmstudio' | 'sillytavern';

export type TransferChatInfo = Pick<
    SiteChatMeta,
    | 'customModel'
    | 'title'
    | 'createdAt'
    | 'systemPrompt'
    | 'providerId'
    | 'modelId'
>;

export interface ImportedMessage {
    role: 'user' | 'assistant';
    text: string;
}

export interface ImportedChat {
    customModel?: CustomModelConfig;
    title: string;
    createdAt: number;
    systemPrompt: string;
    model: string | null;
    messages: ImportedMessage[];
}

type ImportRecord = { chat: ImportedChat } | { error: string };

export const MAX_IMPORT_FILE_BYTES = 100 * 1024 * 1024;
const MAX_MESSAGES_PER_CHAT = 20000;
const MAX_TEXT_CHARS_PER_MESSAGE = 5 * 1024 * 1024;
export const MAX_TITLE_CHARS = 255;
const MAX_MODEL_CHARS = 200;
const MAX_SYSTEM_PROMPT_CHARS = 100000;

function isControlOrBidiChar(c: string): boolean {
    const code = c.codePointAt(0) ?? 0;
    return (
        code < 32 ||
        (code >= 0x7f && code <= 0x9f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
    );
}

export function cleanInline(value: unknown, maxChars: number): string {
    if (typeof value !== 'string') return '';
    return Array.from(value.slice(0, maxChars * 2))
        .filter((c) => !isControlOrBidiChar(c))
        .join('')
        .trim()
        .slice(0, maxChars);
}

function cleanCreatedAt(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    if (value <= 0 || value > Date.now() + 86400000) return 0;
    return Math.floor(value);
}

function cleanBody(value: string): string {
    return value.slice(0, MAX_TEXT_CHARS_PER_MESSAGE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function attachmentNames(msg: AirmailAIMessage): string[] {
    const names: string[] = [];
    for (const part of msg.parts) {
        if (part.type === 'file') names.push(part.filename);
    }
    return names;
}

export function buildMarkdownExport(
    info: TransferChatInfo,
    messages: AirmailAIMessage[]
): string {
    let md =
        `# ${info.title}\n` +
        `Model: ${info.providerId}/${info.modelId}\n` +
        `Created: ${new Date(info.createdAt).toLocaleString()}\n` +
        `Exported from: AirmailAI\n`;
    for (const msg of messages) {
        md += `\n### ${msg.role === 'user' ? 'User' : 'Assistant'}\n`;
        const attachments = attachmentNames(msg);
        if (attachments.length) {
            md += `Attachments: ${attachments.join(', ')}\n`;
        }
        md += `${messageText(msg)}\n`;
    }
    return md;
}

function conversationTokenCount(messages: AirmailAIMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'assistant' && msg.metadata.tokens) {
            return msg.metadata.tokens.input + msg.metadata.tokens.output;
        }
    }
    return 0;
}

function conversationJson(
    info: TransferChatInfo,
    messages: AirmailAIMessage[]
): Record<string, unknown> {
    const senderName = `${info.providerId}/${info.modelId}`;
    return {
        name: info.title,
        pinned: false,
        createdAt: info.createdAt,
        preset: '',
        tokenCount: conversationTokenCount(messages),
        systemPrompt: info.systemPrompt,
        messages: messages.map((msg) =>
            msg.role === 'user'
                ? {
                      versions: [
                          {
                              type: 'singleStep',
                              role: 'user',
                              content: [
                                  { type: 'text', text: messageText(msg) },
                              ],
                          },
                      ],
                      currentlySelected: 0,
                  }
                : {
                      versions: [
                          {
                              type: 'multiStep',
                              role: 'assistant',
                              senderInfo: { senderName },
                              steps: [
                                  {
                                      type: 'contentBlock',
                                      stepIdentifier: `${msg.metadata.createdAt}-${Math.random()}`,
                                      content: [
                                          {
                                              type: 'text',
                                              text: messageText(msg),
                                          },
                                      ],
                                      defaultShouldIncludeInContext: true,
                                      shouldIncludeInContext: true,
                                  },
                              ],
                          },
                      ],
                      currentlySelected: 0,
                  }
        ),
    };
}

export function buildJsonExport(
    info: TransferChatInfo,
    messages: AirmailAIMessage[]
): string {
    return JSON.stringify(conversationJson(info, messages), null, 2);
}

export function buildAirmailAIJsonExport(
    info: TransferChatInfo,
    messages: AirmailAIMessage[]
): string {
    return JSON.stringify(airmailaiChatJson(info, messages), null, 2);
}

function airmailaiChatJson(
    info: TransferChatInfo,
    messages: AirmailAIMessage[]
): Record<string, unknown> {
    return {
        customModel: info.customModel,
        title: info.title,
        createdAt: info.createdAt,
        model: `${info.providerId}/${info.modelId}`,
        systemPrompt: info.systemPrompt,
        messages: messages.map((msg) => ({
            role: msg.role,
            text: messageText(msg),
        })),
    };
}

export function buildBackupDocument(
    info: TransferChatInfo,
    messages: AirmailAIMessage[]
): Blob {
    try {
        const record = airmailaiChatJson(info, messages);
        parseConversation(record, true);
        const blob = new Blob([JSON.stringify(record, null, 2), '\n']);
        if (blob.size > MAX_IMPORT_FILE_BYTES)
            throw new Error('chat exceeds the 100 MiB backup document limit');
        return blob;
    } catch (error) {
        throw new Error(
            `Conversation "${info.title}": ${errorMessage(error)}`,
            { cause: error }
        );
    }
}

export function buildSillyTavernExport(
    info: TransferChatInfo,
    messages: AirmailAIMessage[]
): string {
    const lines: string[] = [
        JSON.stringify({
            chat_metadata: {},
            user_name: 'User',
            character_name: info.title,
        }),
    ];
    for (const msg of messages) {
        const text = messageText(msg);
        const sendDate = new Date(msg.metadata.createdAt).toISOString();
        lines.push(
            msg.role === 'user'
                ? JSON.stringify({
                      name: 'User',
                      is_user: true,
                      is_system: false,
                      send_date: sendDate,
                      mes: text,
                      extra: {},
                  })
                : JSON.stringify({
                      name: 'Assistant',
                      is_user: false,
                      is_system: false,
                      send_date: sendDate,
                      mes: text,
                      extra: {
                          api: info.providerId,
                          model: info.modelId,
                          reasoning: '',
                      },
                      swipes: [text],
                      swipe_id: 0,
                  })
        );
    }
    return lines.join('\n') + '\n';
}

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

function safeFilenameTitle(title: string): string {
    return title.replace(/[/\\:*?"<>|]/g, '-');
}

function dateStamp(d: Date): string {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function sillyTavernFilename(title: string, createdAt: number): string {
    const created = new Date(createdAt);
    const stamp =
        `${dateStamp(created)}` +
        `@${pad2(created.getHours())}h${pad2(created.getMinutes())}m${pad2(created.getSeconds())}s` +
        `${String(created.getMilliseconds()).padStart(3, '0')}ms`;
    return `${safeFilenameTitle(title)} - ${stamp}.jsonl`;
}

export function exportFilename(
    title: string,
    createdAt: number,
    extension: string
): string {
    const created = new Date(createdAt);
    const stamp = `${dateStamp(created)} ${pad2(created.getHours())}.${pad2(created.getMinutes())}`;
    return `${safeFilenameTitle(title)} - ${stamp}${extension}`;
}

export function backupFilename(now: Date): string {
    return `airmailai-backup-${dateStamp(now)}-${pad2(now.getHours())}.${pad2(now.getMinutes())}.${pad2(now.getSeconds())}.yaml`;
}

function titleFromFilename(filename: string): string {
    const base = filename.replace(/\.[^.]*$/, '');
    const sep = base.lastIndexOf(' - ');
    const stem = sep > 0 ? base.slice(0, sep) : base;
    return cleanInline(stem, MAX_TITLE_CHARS);
}

function looksLikeSillyTavern(text: string): boolean {
    const nl = text.indexOf('\n');
    if (nl === -1) return false;
    const firstLine = text.slice(0, nl).trim();
    if (!firstLine.startsWith('{')) return false;
    try {
        const parsed: unknown = JSON.parse(firstLine);
        return isRecord(parsed) && 'chat_metadata' in parsed;
    } catch {
        return false;
    }
}

async function* backupDocuments(file: Blob): AsyncGenerator<Blob> {
    const chunkSize = 1024 * 1024;
    const dash = 0x2d;
    const lineFeed = 0x0a;
    const carriageReturn = 0x0d;
    let contentStart = 0;
    let documentStart = 0;
    for (let start = 0; start < file.size; start += chunkSize) {
        const offset = Math.max(0, start - 1);
        const end = Math.min(start + chunkSize, file.size);
        const bytes = new Uint8Array(
            await file.slice(offset, end + 4).arrayBuffer()
        );
        if (
            start === 0 &&
            bytes[0] === 0xef &&
            bytes[1] === 0xbb &&
            bytes[2] === 0xbf
        ) {
            contentStart = 3;
            documentStart = contentStart;
        }
        for (
            let i = bytes.indexOf(dash, start - offset);
            i >= 0 && offset + i < end;
            i = bytes.indexOf(dash, i + 1)
        ) {
            if (
                (offset + i !== contentStart && bytes[i - 1] !== lineFeed) ||
                bytes[i + 1] !== dash ||
                bytes[i + 2] !== dash
            )
                continue;
            const after = bytes[i + 3] === carriageReturn ? i + 4 : i + 3;
            if (offset + after !== file.size && bytes[after] !== lineFeed)
                continue;
            yield file.slice(documentStart, offset + i);
            documentStart = Math.min(file.size, offset + after + 1);
        }
    }
    yield file.slice(documentStart);
}

async function* readBackup(file: Blob): AsyncGenerator<ImportRecord> {
    let docNo = 0;
    for await (const blob of backupDocuments(file)) {
        if (blob.size > MAX_IMPORT_FILE_BYTES) {
            yield { error: `document ${++docNo} exceeds 100 MiB` };
            continue;
        }
        const doc = await blob.text();
        if (!doc.trim()) continue;
        docNo++;
        try {
            yield { chat: parseJsonTransfer(doc, true) };
        } catch (err) {
            yield { error: `document ${docNo}: ${errorMessage(err)}` };
        }
    }
    if (!docNo) throw new Error('file is empty');
}

export async function* readChatTransferFile(
    file: File
): AsyncGenerator<ImportRecord> {
    const lower = file.name.toLowerCase();
    if (/\.ya?ml$/.test(lower)) {
        yield* readBackup(file);
        return;
    }
    if (file.size > MAX_IMPORT_FILE_BYTES)
        throw new Error(`file is too large (${file.size} bytes)`);
    const text = await file.text();
    if (lower.endsWith('.jsonl'))
        yield {
            chat: parseSillyTavernTransfer(titleFromFilename(file.name), text),
        };
    else if (lower.endsWith('.json')) yield { chat: parseJsonTransfer(text) };
    else if (lower.endsWith('.md')) yield { chat: parseMarkdownTransfer(text) };
    else if (looksLikeSillyTavern(text))
        yield {
            chat: parseSillyTavernTransfer(titleFromFilename(file.name), text),
        };
    else if (text.trimStart().startsWith('{')) {
        if (/\n---\r?(\n|$)/.test(text)) yield* readBackup(file);
        else yield { chat: parseJsonTransfer(text) };
    } else yield { chat: parseMarkdownTransfer(text) };
}

function parseSillyTavernTransfer(
    fallbackTitle: string,
    text: string
): ImportedChat {
    let title = '';
    let model: string | null = null;
    let createdAt = 0;
    const messages: ImportedMessage[] = [];
    let isFirstRecord = true;
    let lineNo = 0;

    for (const rawLine of text.split('\n')) {
        lineNo++;
        const line = rawLine.trim();
        if (!line) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch (err) {
            throw new Error(`line ${lineNo} is not valid JSON`, {
                cause: err,
            });
        }
        if (!isRecord(parsed)) continue;
        if (isFirstRecord) {
            isFirstRecord = false;
            if ('chat_metadata' in parsed || 'character_name' in parsed) {
                const charName = cleanInline(
                    parsed.character_name,
                    MAX_TITLE_CHARS
                );
                if (charName && charName.toLowerCase() !== 'unused') {
                    title = charName;
                }
                continue;
            }
        }
        if (parsed.is_system === true) continue;
        if (typeof parsed.mes !== 'string') continue;
        const mes = parsed.mes.trim();
        if (!mes) continue;
        if (messages.length >= MAX_MESSAGES_PER_CHAT) {
            throw new Error('chat has too many messages');
        }
        const role = parsed.is_user === true ? 'user' : 'assistant';
        if (!createdAt && typeof parsed.send_date === 'string') {
            createdAt = cleanCreatedAt(new Date(parsed.send_date).getTime());
        }
        if (!model && role === 'assistant' && isRecord(parsed.extra)) {
            const api = cleanInline(parsed.extra.api, MAX_MODEL_CHARS);
            const modelName = cleanInline(parsed.extra.model, MAX_MODEL_CHARS);
            if (api && modelName) {
                model = `${api}/${modelName}`.slice(0, MAX_MODEL_CHARS);
            } else if (modelName) {
                model = modelName;
            }
        }
        messages.push({ role, text: cleanBody(mes) });
    }

    if (messages.length === 0) throw new Error('no messages found');
    return {
        title: title || fallbackTitle,
        createdAt,
        systemPrompt: '',
        model,
        messages,
    };
}

function parseMarkdownTransfer(text: string): ImportedChat {
    let title = '';
    let model: string | null = null;
    let createdAt = 0;
    const messages: ImportedMessage[] = [];
    let role: ImportedMessage['role'] | null = null;
    let body: string[] = [];

    const flush = () => {
        if (!role) return;
        const joined = body.join('\n').trim();
        if (joined) messages.push({ role, text: cleanBody(joined) });
        body = [];
    };

    for (const rawLine of text.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        const heading = line.trim();
        if (heading === '### User' || heading === '### Assistant') {
            flush();
            if (messages.length >= MAX_MESSAGES_PER_CHAT) {
                throw new Error('chat has too many messages');
            }
            role = heading === '### User' ? 'user' : 'assistant';
            continue;
        }
        if (role) {
            body.push(line);
            continue;
        }
        if (!title && line.startsWith('# ')) {
            title = cleanInline(line.slice(2), MAX_TITLE_CHARS);
        } else if (!model && line.startsWith('Model: ')) {
            model = cleanInline(line.slice(7), MAX_MODEL_CHARS) || null;
        } else if (!createdAt && line.startsWith('Created: ')) {
            createdAt = cleanCreatedAt(new Date(line.slice(9)).getTime());
        }
    }
    flush();

    if (messages.length === 0) {
        throw new Error('no "### User" or "### Assistant" sections found');
    }
    return { title, createdAt, systemPrompt: '', model, messages };
}

function parseJsonTransfer(text: string, backup = false): ImportedChat {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new Error('file is not valid JSON', { cause: err });
    }
    return parseConversation(parsed, backup);
}

function textFromContent(content: unknown): string {
    if (!Array.isArray(content)) return '';
    let out = '';
    for (const item of content) {
        if (
            isRecord(item) &&
            item.type === 'text' &&
            typeof item.text === 'string'
        ) {
            out += item.text;
        }
    }
    return out;
}

function parseConversation(value: unknown, backup = false): ImportedChat {
    if (!isRecord(value)) throw new Error('chat is not a JSON object');
    const rawMessages = value.messages;
    if (!Array.isArray(rawMessages)) {
        throw new Error('chat has no "messages" array');
    }
    if (rawMessages.length > MAX_MESSAGES_PER_CHAT) {
        throw new Error('chat has too many messages');
    }
    if (backup) {
        if (
            typeof value.title === 'string' &&
            value.title.length > MAX_TITLE_CHARS
        )
            throw new Error('chat title is too long');
        if (
            typeof value.systemPrompt === 'string' &&
            value.systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS
        )
            throw new Error('system prompt is too long');
        if (
            !value.customModel &&
            typeof value.model === 'string' &&
            value.model.length > MAX_MODEL_CHARS
        )
            throw new Error('model name is too long');
    }

    const title =
        cleanInline(value.title, MAX_TITLE_CHARS) ||
        cleanInline(value.name, MAX_TITLE_CHARS);
    const createdAt = cleanCreatedAt(value.createdAt);
    const systemPrompt =
        typeof value.systemPrompt === 'string'
            ? value.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_CHARS)
            : '';
    const customModel = value.customModel;
    if (customModel != null) {
        validateCustomModelConfig(customModel);
    }
    let model: string | null =
        customModel && typeof value.model === 'string'
            ? value.model
            : cleanInline(value.model, MAX_MODEL_CHARS) || null;
    if (customModel && model) {
        const slash = model.indexOf('/');
        validateModelIdLength(slash < 0 ? model : model.slice(slash + 1));
    }
    const messages: ImportedMessage[] = [];

    for (const entry of rawMessages) {
        if (!isRecord(entry)) continue;
        if (typeof entry.text === 'string') {
            const role =
                entry.role === 'user'
                    ? 'user'
                    : entry.role === 'assistant'
                      ? 'assistant'
                      : null;
            if (!role) continue;
            if (backup && entry.text.length > MAX_TEXT_CHARS_PER_MESSAGE)
                throw new Error('message is too long');
            const text = backup ? entry.text : entry.text.trim();
            if (!text && !backup) continue;
            messages.push({ role, text: cleanBody(text) });
            continue;
        }
        const versions = entry.versions;
        if (!Array.isArray(versions) || versions.length === 0) continue;
        const selected = entry.currentlySelected;
        const idx =
            typeof selected === 'number' &&
            Number.isInteger(selected) &&
            selected >= 0 &&
            selected < versions.length
                ? selected
                : 0;
        const version: unknown = versions[idx];
        if (!isRecord(version)) continue;
        const role =
            version.role === 'user'
                ? 'user'
                : version.role === 'assistant'
                  ? 'assistant'
                  : null;
        if (!role) continue;

        let text = textFromContent(version.content);
        if (Array.isArray(version.steps)) {
            for (const step of version.steps) {
                if (isRecord(step) && step.type === 'contentBlock') {
                    text += textFromContent(step.content);
                }
            }
        }
        if (!model && role === 'assistant' && isRecord(version.senderInfo)) {
            model =
                cleanInline(version.senderInfo.senderName, MAX_MODEL_CHARS) ||
                null;
        }
        text = text.trim();
        if (!text) continue;
        messages.push({ role, text: cleanBody(text) });
    }

    if (messages.length === 0 && !(backup && rawMessages.length === 0))
        throw new Error('no messages found');
    return {
        title,
        createdAt,
        systemPrompt,
        model,
        messages,
        ...(customModel ? { customModel } : {}),
    };
}
