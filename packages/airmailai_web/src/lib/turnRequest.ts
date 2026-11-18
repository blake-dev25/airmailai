import type { TurnStartRequest } from '@airmailai/shared';
import { chatToMeta } from './chatRecords';
import { tabId } from './extension';
import { customModelTools } from './models/custom';
import { providersStore } from './providersStore.svelte';
import { settingsStore } from './settingsStore.svelte';
import type { Chat, Message } from './types';

type WireTools = Record<string, string | boolean>;

function findChatModel(chat: Chat) {
    return providersStore.providers
        .find((p) => p.id === chat.providerId)
        ?.models.find((m) => m.id === chat.modelId);
}

export function resolveWireTools(chat: Chat): WireTools {
    const wireTools: WireTools = {};
    const modelTools = chat.customModel
        ? customModelTools(chat.providerId, chat.customModel)
        : findChatModel(chat)?.tools;
    const toolConfig = chat.customModel ?? chat;
    if (
        modelTools?.webSearch &&
        settingsStore.enableWebSearch &&
        toolConfig.webSearch
    ) {
        wireTools.webSearch = modelTools.webSearch;
    }
    if (
        modelTools?.webFetch &&
        settingsStore.enableWebFetch &&
        toolConfig.webFetch
    ) {
        wireTools.webFetch = modelTools.webFetch;
    }
    if (
        modelTools?.codeExecution &&
        settingsStore.enableCodeExecution &&
        toolConfig.codeExecution
    ) {
        wireTools.codeExecution = modelTools.codeExecution;
    }
    return wireTools;
}

export function buildTurnRequest(
    chat: Chat,
    assistantMessageId: string,
    assistantMessage: Message,
    wireTools: WireTools
): Omit<TurnStartRequest, 'type'> {
    const modelParams = findChatModel(chat)?.params;
    return {
        chatId: chat.id,
        sourceTabId: tabId,
        provider: chat.providerId,
        model: chat.modelId,
        ...(chat.systemPrompt.trim() ? { system: chat.systemPrompt } : {}),
        params: {
            ...(chat.customModel
                ? { customModel: { ...chat.customModel } }
                : {
                      ...(modelParams?.temperatureMax !== undefined
                          ? { temperature: chat.temperature }
                          : {}),
                      maxTokens: chat.maxTokens,
                      ...(modelParams?.thinking
                          ? {
                                thinkingLevel: chat.thinkingLevel,
                                adaptiveThinking: chat.adaptiveThinking,
                            }
                          : {}),
                  }),
            tools: wireTools,
            tagOpenRouterRequests: settingsStore.tagOpenRouterRequests,
            openRouterPdfEngine: settingsStore.openRouterPdfEngine,
        },
        meta: chatToMeta(chat),
        assistantMessageId,
        assistantCreatedAt: assistantMessage.metadata.createdAt,
    };
}
