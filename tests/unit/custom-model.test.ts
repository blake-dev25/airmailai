import { describe, expect, spyOn, test } from 'bun:test';
import {
    emptyCustomModelConfig,
    isCustomModelConfig,
    type CustomModelConfig,
} from '../../packages/shared/src/custom-model';
import { streamAnthropic } from '../../packages/airmailai_ext/providers/anthropic';
import {
    buildAirmailAIJsonExport,
    parseChatTransferFile,
} from '../../packages/airmailai_web/src/lib/chatTransfer';
import { validateModelRequest } from '../../packages/airmailai_web/src/lib/modelValidation';
import { customModelTools } from '../../packages/airmailai_web/src/lib/models/custom';
import { validateSettingsForStorage } from '../../packages/airmailai_web/src/lib/settingsValidation';

function importCustomConfig(
    customModel: unknown,
    model = 'google/gemini-test'
) {
    return parseChatTransferFile(
        'chat.json',
        JSON.stringify({
            model,
            customModel,
            messages: [{ role: 'user', text: 'hello' }],
        })
    ).chats[0];
}

describe('Google model request routing', () => {
    test.each([
        'models/%2e%2e/files#',
        'models/%2E%2E/files#',
        'models/%252e%252e/files#',
        'models/gemini-test:generateContent#',
        'gemini-test?alt=json',
        'gemini-test&key=other',
        '../files',
        'models/../files',
        'models/./gemini-test',
        'models/gemini-test/../../files',
        'models\\gemini-test',
        'https://example.com/model',
        '//example.com/model',
        '.',
        '..',
        'gemini-test\n',
        'gemini-\rtest',
        'gemini-test\0',
        ' gemini-test',
        'gemini-test ',
    ])('rejects URL-changing input %j', (model) => {
        expect(() => validateModelRequest('google', model, null)).toThrow(
            'Google model IDs'
        );
    });

    test.each([
        'gemini-2.5-flash',
        'models/gemini-test',
        'tunedModels/custom-123',
        'future_MODEL.v4~preview',
    ])('accepts safe model syntax %j', (model) => {
        expect(() => validateModelRequest('google', model, null)).not.toThrow();
    });

    test('imported model IDs meet the same send check', () => {
        const imported = importCustomConfig(
            emptyCustomModelConfig('google'),
            'google/models/%2e%2e/files#'
        );
        expect(() =>
            validateModelRequest(
                'google',
                imported.model!.slice('google/'.length),
                imported.customModel
            )
        ).toThrow('Google model IDs');
    });

    test.each(['openai', 'anthropic', 'openrouter'])(
        'leaves JSON model syntax unrestricted for %s',
        (provider) => {
            expect(() =>
                validateModelRequest(
                    provider,
                    '~vendor/model:variant%?#/\\\n',
                    null
                )
            ).not.toThrow();
            expect(() =>
                validateModelRequest(provider, 'x'.repeat(256), null)
            ).not.toThrow();
            expect(() =>
                validateModelRequest(provider, 'x'.repeat(257), null)
            ).toThrow('256 characters');
        }
    );
});

describe('custom configuration storage', () => {
    test.each([
        'temperature',
        'maxTokens',
        'thinkingLevel',
        'thinkingBudget',
        'webSearch',
        'webFetch',
        'codeExecution',
    ] as const)('bounds the %s text field', (key) => {
        const config = emptyCustomModelConfig('anthropic');
        config[key] = 'x'.repeat(128);
        expect(isCustomModelConfig(config)).toBe(true);
        config[key] += 'x';
        expect(isCustomModelConfig(config)).toBe(false);
        expect(() => importCustomConfig(config)).toThrow('128 characters');
        expect(() =>
            validateSettingsForStorage({ customModel: config })
        ).toThrow('128 characters');
    });

    test('rejects unknown, inherited, and incorrectly typed fields', () => {
        const config = emptyCustomModelConfig('google');
        expect(() =>
            importCustomConfig({ ...config, extra: 'payload' })
        ).toThrow('unknown fields');
        expect(isCustomModelConfig(Object.create(config))).toBe(false);
        expect(isCustomModelConfig({ ...config, temperature: 1 })).toBe(false);
        expect(
            isCustomModelConfig({ ...config, adaptiveThinking: 'true' })
        ).toBe(false);
        expect(isCustomModelConfig([])).toBe(false);
    });

    test('bounds imported model IDs independently of the provider prefix', () => {
        const config = emptyCustomModelConfig('openrouter');
        expect(
            importCustomConfig(config, 'openrouter/' + '~'.repeat(256)).model
        ).toBe('openrouter/' + '~'.repeat(256));
        expect(() =>
            importCustomConfig(config, 'openrouter/' + '~'.repeat(257))
        ).toThrow('256 characters');
    });

    test('counts serialized JSON bytes before saving settings', () => {
        expect(() =>
            validateSettingsForStorage({ modelId: '\0'.repeat(1400) })
        ).toThrow('8192-byte');
        expect(() =>
            validateSettingsForStorage({ modelId: '\u20ac'.repeat(2800) })
        ).toThrow('8192-byte');
        expect(() =>
            validateSettingsForStorage({
                customModel: {
                    ...emptyCustomModelConfig('google'),
                    thinkingLevel: 'x'.repeat(9000),
                },
            })
        ).toThrow('8192-byte');
    });

    test('the largest allowed custom fields fit together even with JSON escaping', () => {
        const text = '\0'.repeat(128);
        const customModel: CustomModelConfig = {
            temperature: text,
            maxTokens: text,
            thinkingLevel: text,
            thinkingBudget: text,
            adaptiveThinking: false,
            webSearch: text,
            webFetch: text,
            codeExecution: text,
        };
        expect(() =>
            validateSettingsForStorage({
                customModel,
                modelId: '\0'.repeat(256),
            })
        ).not.toThrow();
    });

    test('bounds other unrestricted synced strings', () => {
        expect(() =>
            validateSettingsForStorage({ thinkingLevel: 'x'.repeat(129) })
        ).toThrow('128 characters');
        expect(() =>
            validateSettingsForStorage({
                legalAcceptedVersion: 'x'.repeat(129),
            })
        ).toThrow('128 characters');
    });
});

describe('custom Anthropic tools', () => {
    test('preserves user tool types through export, import, and request construction', async () => {
        const customModel = {
            ...emptyCustomModelConfig('anthropic'),
            webSearch: 'web_search_future',
            webFetch: 'web_fetch_future',
            codeExecution: 'code_execution_future',
        };
        const exported = buildAirmailAIJsonExport(
            {
                customModel,
                title: 'Tools',
                createdAt: 1,
                systemPrompt: '',
                providerId: 'anthropic',
                modelId: 'claude-future',
            },
            [
                {
                    id: 'user',
                    role: 'user',
                    parts: [{ type: 'text', text: 'hello', state: 'done' }],
                    metadata: { createdAt: 1 },
                },
            ]
        );
        const imported = parseChatTransferFile('chat.json', exported).chats[0];
        expect(imported.customModel).toEqual(customModel);
        const bodies: Array<{ tools?: Array<{ type: string }> }> = [];
        const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
            Object.assign(
                async (
                    input: Parameters<typeof fetch>[0],
                    init?: Parameters<typeof fetch>[1]
                ) => {
                    const request =
                        input instanceof Request
                            ? input
                            : new Request(input, init);
                    expect(new URL(request.url).origin).toBe(
                        'https://api.anthropic.com'
                    );
                    bodies.push(JSON.parse(await request.text()));
                    return new Response('', {
                        status: 200,
                        headers: { 'content-type': 'text/event-stream' },
                    });
                },
                { preconnect: globalThis.fetch.preconnect }
            )
        );
        try {
            const chunks = streamAnthropic({
                apiKey: 'fake-unit-test-key',
                model: 'claude-future',
                messages: [],
                params: {
                    customModel: imported.customModel,
                    tools: customModelTools('anthropic', imported.customModel!),
                },
            });
            for await (const chunk of chunks) expect(chunk.type).toBe('finish');
            expect(bodies).toHaveLength(1);
            expect(bodies[0].tools?.map((tool) => tool.type)).toEqual([
                customModel.webSearch,
                customModel.webFetch,
                customModel.codeExecution,
            ]);
        } finally {
            fetchMock.mockRestore();
        }
    });

    test('omits blank tool inputs and keeps nonblank values unchanged', () => {
        const config = emptyCustomModelConfig('anthropic');
        expect(customModelTools('anthropic', config)).toEqual({});
        config.webSearch = '   ';
        config.webFetch = ' web_fetch_future ';
        expect(customModelTools('anthropic', config)).toEqual({
            webFetch: ' web_fetch_future ',
        });
    });

    test.each(['google', 'openai', 'openrouter'])(
        'keeps supported tools as toggles for %s',
        (provider) => {
            const config = emptyCustomModelConfig(provider);
            expect(config.webSearch).toBe(false);
            expect(customModelTools(provider, config)).toEqual({});
            config.webSearch = true;
            expect(customModelTools(provider, config)).toEqual({
                webSearch: true,
            });
        }
    );
});
