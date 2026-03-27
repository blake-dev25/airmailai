import type {
  ExtensionRequest,
  ExtensionResponse,
  StorageRequest,
  StorageResponse,
  UserSettings,
} from '@courier/shared';
import { SETTINGS_KEYS } from '@courier/shared';
import { DEBUG_API_LOGGING } from '../debug';
import { streamAnthropic } from '../providers/anthropic';
import { streamOpenAI } from '../providers/openai';
import {
  dbClearChats,
  dbDeleteChat,
  dbLoadChat,
  dbLoadChatMetas,
  dbLoadChats,
  dbLoadChatsByIds,
  dbSaveChat,
} from '../storage/db';

const LOG = '[courier:ext]';

async function handleStorage(
  message: StorageRequest
): Promise<StorageResponse> {
  console.log(LOG, '← storage request', message.type);
  switch (message.type) {
    case 'save_key': {
      console.log(LOG, 'storage: saving API key for', message.provider);
      await chrome.storage.sync.set({
        [`apiKey_${message.provider}`]: message.apiKey,
      });
      console.log(LOG, '→ storage response: saved');
      return { type: 'saved' };
    }
    case 'clear_key': {
      console.log(LOG, 'storage: clearing API key for', message.provider);
      await chrome.storage.sync.remove(`apiKey_${message.provider}`);
      console.log(LOG, '→ storage response: saved');
      return { type: 'saved' };
    }
    case 'has_keys': {
      const storageKeys = message.providers.map((p) => `apiKey_${p}`);
      const result = await chrome.storage.sync.get(storageKeys);
      const saved: Record<string, boolean> = {};
      for (const p of message.providers) {
        const val = result[`apiKey_${p}`];
        saved[p] = typeof val === 'string' && val.length > 0;
      }
      console.log(LOG, '→ storage response: has_keys', saved);
      return { type: 'has_keys', saved };
    }
    case 'save_settings': {
      console.log(LOG, 'storage: saving settings', message.settings);
      await chrome.storage.sync.set(message.settings);
      console.log(LOG, '→ storage response: saved');
      return { type: 'saved' };
    }
    case 'load_settings': {
      const result = await chrome.storage.sync.get(SETTINGS_KEYS);
      console.log(LOG, '→ storage response: settings', result);
      return { type: 'settings', settings: result as Partial<UserSettings> };
    }
    case 'save_chat': {
      await dbSaveChat(message.chat, message.meta);
      console.log(LOG, '→ storage response: saved');
      return { type: 'saved' };
    }
    case 'delete_chat': {
      await dbDeleteChat(message.chatId);
      console.log(LOG, '→ storage response: saved');
      return { type: 'saved' };
    }
    case 'load_chat_metas': {
      const metas = await dbLoadChatMetas();
      console.log(
        LOG,
        '→ storage response: chat_metas',
        `${metas.length} metas`
      );
      return { type: 'chat_metas', metas };
    }
    case 'load_chats': {
      const chats = await dbLoadChats();
      console.log(LOG, '→ storage response: chats', `${chats.length} chats`);
      return { type: 'chats', chats };
    }
    case 'load_chats_by_ids': {
      const chats = await dbLoadChatsByIds(message.ids);
      console.log(LOG, '→ storage response: chats', `${chats.length} chats`);
      return { type: 'chats', chats };
    }
    case 'load_chat': {
      const chat = await dbLoadChat(message.chatId);
      console.log(
        LOG,
        '→ storage response: chat',
        message.chatId,
        chat ? 'found' : 'not found'
      );
      return { type: 'chat', chat };
    }
  }
}

export default defineBackground(() => {
  console.log(LOG, 'background ready');

  // Internal messages from the popup
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'admin_clear_chats') {
      dbClearChats()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (message.type === 'admin_clear_all') {
      Promise.all([dbClearChats(), chrome.storage.sync.clear()])
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
  });

  // One-off storage operations (save/check API keys, settings, chat history)
  chrome.runtime.onMessageExternal.addListener(
    (message: StorageRequest, _sender, sendResponse) => {
      handleStorage(message).then(sendResponse);
      return true; // keep channel open for async response
    }
  );

  // Streaming chat over a port
  chrome.runtime.onConnectExternal.addListener((port) => {
    console.log(LOG, 'port connected');

    port.onMessage.addListener(async (request: ExtensionRequest) => {
      const send = (response: ExtensionResponse) => port.postMessage(response);

      const keyResult = await chrome.storage.sync.get(
        `apiKey_${request.provider}`
      );
      const apiKey = keyResult[`apiKey_${request.provider}`] as
        | string
        | undefined;

      if (!apiKey) {
        console.error(LOG, 'no API key for provider', request.provider);
        send({
          type: 'error',
          message: `No API key saved for ${request.provider}. Add one in Settings.`,
        });
        return;
      }

      console.log(LOG, 'api key found, routing to provider', request.provider, {
        model: request.model,
        messages: request.messages.length,
      });

      if (DEBUG_API_LOGGING) {
        console.log(LOG, '[debug] full request', {
          provider: request.provider,
          model: request.model,
          params: request.params,
          messages: request.messages,
        });
      }

      switch (request.provider) {
        case 'anthropic':
          await streamAnthropic(
            apiKey,
            request.model,
            request.messages,
            request.params ?? {},
            (text) => send({ type: 'chunk', content: text }),
            (usage) => send({ type: 'done', usage: usage ?? undefined }),
            (msg) => send({ type: 'error', message: msg }),
            (text) => send({ type: 'thinking_chunk', content: text })
          );
          break;
        case 'openai':
          await streamOpenAI(
            apiKey,
            request.model,
            request.messages,
            request.params ?? {},
            (text) => send({ type: 'chunk', content: text }),
            (usage) => send({ type: 'done', usage: usage ?? undefined }),
            (msg) => send({ type: 'error', message: msg }),
            (text) => send({ type: 'thinking_chunk', content: text })
          );
          break;
        default:
          console.error(LOG, 'unsupported provider', request.provider);
          send({
            type: 'error',
            message: `Unsupported provider: ${request.provider}`,
          });
      }
    });
  });
});
