import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { OpenRouter } from '@openrouter/sdk';
import OpenAI from 'openai';

type Provider = 'anthropic' | 'google' | 'openai' | 'openrouter';

interface Args {
    provider: Provider;
    model: string;
    filePath: string;
    mimeType: string;
}

const PROMPT = 'Read the attached file.';

function usage(): never {
    throw new Error(
        [
            'Usage:',
            '  bun scripts/file-upload-test.ts --provider <anthropic|google|openai|openrouter> --model <model-id> --file-path <path> --mime-type <mime>',
            '',
            'Example:',
            '  bun scripts/file-upload-test.ts --provider openai --model gpt-5.5 --file-path ./sample.pdf --mime-type application/pdf',
        ].join('\n')
    );
}

function readFlag(name: string): string | undefined {
    const idx = process.argv.indexOf(name);
    if (idx < 0) return undefined;
    const value = process.argv[idx + 1];
    if (!value || value.startsWith('--')) return undefined;
    return value;
}

function parseProvider(value: string | undefined): Provider {
    if (
        value === 'anthropic' ||
        value === 'google' ||
        value === 'openai' ||
        value === 'openrouter'
    ) {
        return value;
    }
    usage();
}

function parseArgs(): Args {
    const provider = parseProvider(readFlag('--provider'));
    const model = readFlag('--model');
    const filePath = readFlag('--file-path');
    const mimeType = readFlag('--mime-type');
    if (!model || !filePath || !mimeType) usage();
    return {
        provider,
        model,
        filePath: resolve(filePath),
        mimeType,
    };
}

function getEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} missing from .env`);
    return value;
}

function readBase64(filePath: string): string {
    return readFileSync(filePath).toString('base64');
}

function decodeBase64Utf8(data: string): string {
    const bytes = Uint8Array.from(Buffer.from(data, 'base64'));
    return new TextDecoder().decode(bytes);
}

function dataUrl(mimeType: string, data: string): string {
    return `data:${mimeType};base64,${data}`;
}

function serializeError(error: unknown): unknown {
    if (!(error instanceof Error)) return error;

    const out: Record<string, unknown> = {
        name: error.name,
        message: error.message,
    };
    for (const key of Object.getOwnPropertyNames(error)) {
        out[key] = (error as unknown as Record<string, unknown>)[key];
    }
    return out;
}

function toOpenAIContent(filename: string, mimeType: string, data: string) {
    if (mimeType.startsWith('image/')) {
        return [
            { type: 'input_image', image_url: dataUrl(mimeType, data) },
            { type: 'input_text', text: PROMPT },
        ];
    }

    return [
        {
            type: 'input_file',
            filename,
            file_data: dataUrl(mimeType, data),
        },
        { type: 'input_text', text: PROMPT },
    ];
}

function toOpenRouterContent(filename: string, mimeType: string, data: string) {
    if (mimeType.startsWith('image/')) {
        return [
            {
                type: 'input_image',
                imageUrl: dataUrl(mimeType, data),
                detail: 'auto',
            },
            { type: 'input_text', text: PROMPT },
        ];
    }

    return [
        {
            type: 'input_file',
            filename,
            fileData: dataUrl(mimeType, data),
        },
        { type: 'input_text', text: PROMPT },
    ];
}

function toAnthropicContent(mimeType: string, data: string) {
    const blocks: Anthropic.ContentBlockParam[] = [];

    if (mimeType === 'application/pdf') {
        blocks.push({
            type: 'document',
            source: {
                type: 'base64',
                media_type: 'application/pdf',
                data,
            },
        } as Anthropic.ContentBlockParam);
    } else if (mimeType === 'text/plain') {
        blocks.push({
            type: 'document',
            source: {
                type: 'text',
                media_type: 'text/plain',
                data: decodeBase64Utf8(data),
            },
        });
    } else {
        blocks.push({
            type: 'image',
            source: {
                type: 'base64',
                media_type: mimeType as
                    | 'image/jpeg'
                    | 'image/png'
                    | 'image/gif'
                    | 'image/webp',
                data,
            },
        });
    }

    blocks.push({ type: 'text', text: PROMPT });
    return blocks;
}

async function callAnthropic(args: Args, data: string) {
    const client = new Anthropic({ apiKey: getEnv('ANTHROPIC_API_KEY') });
    return client.messages.create({
        model: args.model,
        max_tokens: 4096,
        messages: [
            {
                role: 'user',
                content: toAnthropicContent(args.mimeType, data),
            },
        ],
    });
}

async function callGoogle(args: Args, data: string) {
    const client = new GoogleGenAI({ apiKey: getEnv('GOOGLE_API_KEY') });
    return client.models.generateContent({
        model: args.model,
        contents: [
            {
                role: 'user',
                parts: [
                    {
                        inlineData: {
                            mimeType: args.mimeType,
                            data,
                        },
                    },
                    { text: PROMPT },
                ],
            },
        ],
        config: { maxOutputTokens: 4096 },
    });
}

async function callOpenAI(args: Args, filename: string, data: string) {
    const client = new OpenAI({ apiKey: getEnv('OPENAI_API_KEY') });
    return client.responses.create({
        model: args.model,
        input: [
            {
                role: 'user',
                content: toOpenAIContent(
                    filename,
                    args.mimeType,
                    data
                ) as never,
            },
        ],
        max_output_tokens: 4096,
    });
}

async function callOpenRouter(args: Args, filename: string, data: string) {
    const client = new OpenRouter({
        apiKey: getEnv('OPENROUTER_API_KEY'),
    });

    return client.beta.responses.send({
        responsesRequest: {
            model: args.model,
            input: [
                {
                    role: 'user',
                    content: toOpenRouterContent(
                        filename,
                        args.mimeType,
                        data
                    ) as never,
                },
            ] as never,
            maxOutputTokens: 4096,
        },
    });
}

async function main(): Promise<void> {
    const args = parseArgs();
    const filename = basename(args.filePath);
    const data = readBase64(args.filePath);

    const response =
        args.provider === 'anthropic'
            ? await callAnthropic(args, data)
            : args.provider === 'google'
              ? await callGoogle(args, data)
              : args.provider === 'openai'
                ? await callOpenAI(args, filename, data)
                : await callOpenRouter(args, filename, data);

    console.log(JSON.stringify(response, null, 2));
}

main().catch((error) => {
    console.error(JSON.stringify(serializeError(error), null, 2));
    process.exit(1);
});
