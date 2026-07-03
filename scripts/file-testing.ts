// *** Discovery + verification harness for code-execution FILE OUTPUTS and the
// attachment send path. The code-exec tests call the provider SDK directly
// (non-streaming, easiest to inspect); the upload test drives the real
// streamAnthropic. Anthropic + OpenAI + Google.
//
//   bun scripts/file-testing.ts --provider anthropic
//   bun scripts/file-testing.ts --provider anthropic --test create --dump
//   bun scripts/file-testing.ts --provider anthropic --model claude-opus-4-8
//   bun scripts/file-testing.ts --provider openai --test shell --dump
//   bun scripts/file-testing.ts --provider google --test create,read
//   bun scripts/file-testing.ts --provider openrouter --test annotations,replay --dump
//
// Tests (anthropic unless noted):
//   stream   do file_ids + container.id surface via STREAMING (beta)?
//   create   do created files auto-return, and can we download + delete them?
//   persist  does a file survive a NEW request with no container reuse?
//   reuse    does passing container.id carry the file into a later request?
//   reref    can a created file_id be re-fed via container_upload (no re-upload)?
//   inline   retrieve a created file WITHOUT the Files API (base64 via stdout)?
//   upload   does a user PDF attachment reach the model via streamAnthropic?
//   editpersist  edit an attached file in the sandbox - does the edit reach
//            the durable file_id? (expected no - the Files API is immutable)
//   shell    (openai) hosted shell tool, NO provisioned container: does a
//            container_id come back + are output files listable/downloadable?
//   expire   (openai) reuse a container after >20min idle - does
//            container_reference still work? (waits 21 min)
//   roundtrip (openai) create -> download -> /v1/files upload -> attach via
//            file_ids: can the model read/EDIT the attached copy?
//   attachwarm (openai) attach a /v1/files upload to a WARM container - does
//            the model see it on container_reference reuse?
//   create   (google) do code-exec outputs surface as inlineData parts, with
//            what metadata, and do they arrive via STREAMING too?
//   read     (google) can code exec READ an attached file's raw bytes
//            (inlineData vs Files-API fileData)?
//   tokens   (google) is a fileData attachment tokenized into the prompt even
//            when code execution consumes it?
//   limit    (google) where does the inline (non-Files-API) request size cap
//            actually sit (~20MB total request)?
//   image    (openrouter) does an input_image data URL reach the model via the
//            responses API?
//   pdf      (openrouter) does an input_file PDF reach the model with
//            engine=native, and do any annotations come back?
//   fallback (openrouter) on a TEXT-ONLY model: is cloudflare-ai fallback
//            built in when no engine is set, and does engine=native error?
//   annotations (openrouter) which annotation types come back per
//            endpoint (responses vs chat completions) x engine (native vs
//            cloudflare-ai), incl. an anthropic/* model for citation passthrough?
//   replay   (openrouter) does resending file annotations skip re-parsing,
//            and can annotations ALONE carry the document on later turns?
//
// OpenRouter tests use raw fetch (not @openrouter/sdk) on purpose: the SDK's
// zod outbound schemas strip fields it doesn't know (e.g. replayed
// `annotations`), which is exactly what these tests probe.
//
// --dump prints the raw result/container JSON for each turn.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { CourierAIMessage } from '@courierai/shared';
import {
    type File as GoogleFile,
    FileState,
    GoogleGenAI,
    type Part as GooglePart,
} from '@google/genai';
import OpenAI, { toFile } from 'openai';
import { PROVIDERS } from '../packages/courierai_web/src/lib/models';

type ProviderName = 'anthropic' | 'google' | 'openai' | 'openrouter';
type TestName =
    | 'stream'
    | 'create'
    | 'persist'
    | 'reuse'
    | 'reref'
    | 'inline'
    | 'upload'
    | 'editpersist';

const ALL_TESTS: TestName[] = [
    'stream',
    'create',
    'persist',
    'reuse',
    'reref',
    'inline',
    'upload',
    'editpersist',
];

type OpenAITestName = 'shell' | 'expire' | 'roundtrip' | 'attachwarm';

const OPENAI_TESTS: OpenAITestName[] = [
    'shell',
    'expire',
    'roundtrip',
    'attachwarm',
];

type GoogleTestName = 'create' | 'read' | 'tokens' | 'limit';

const GOOGLE_TESTS: GoogleTestName[] = ['create', 'read', 'tokens', 'limit'];

type OpenRouterTestName =
    'image' | 'pdf' | 'fallback' | 'annotations' | 'replay';

const OPENROUTER_TESTS: OpenRouterTestName[] = [
    'image',
    'pdf',
    'fallback',
    'annotations',
    'replay',
];

const OPENROUTER_DEFAULT_TEXT_MODEL = 'meta-llama/llama-3.3-70b-instruct';
const OPENROUTER_DEFAULT_CITE_MODEL = 'anthropic/claude-sonnet-4.5';

const PROVIDER_DEFAULTS: Record<ProviderName, { env: string; model: string }> =
    {
        anthropic: { env: 'ANTHROPIC_API_KEY', model: 'claude-haiku-4-5' },
        google: { env: 'GOOGLE_API_KEY', model: 'gemini-3.5-flash' },
        openai: { env: 'OPENAI_API_KEY', model: 'gpt-5.5' },
        openrouter: {
            env: 'OPENROUTER_API_KEY',
            model: 'google/gemini-2.5-flash',
        },
    };

const FILES_BETA = 'files-api-2025-04-14' as const;
const OUT_DIR = join(import.meta.dirname, '.tmp', 'file-testing');

const RESULT_BLOCK_TYPES = new Set([
    'code_execution_tool_result',
    'bash_code_execution_tool_result',
    'text_editor_code_execution_tool_result',
]);

interface ResultRead {
    type: string;
    toolUseId: string;
    fileIds: string[];
    stdout?: string;
    stderr?: string;
    returnCode?: number;
    error?: string;
}

function flag(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function pickTests<T extends string>(
    testArg: string | undefined,
    all: readonly T[]
): T[] {
    if (!testArg || testArg === 'all') return [...all];
    return testArg
        .split(',')
        .filter((t): t is T => (all as readonly string[]).includes(t));
}

function apiErr(e: unknown): string {
    if (e instanceof OpenAI.APIError) return `HTTP ${e.status}`;
    return e instanceof Error ? e.message : String(e);
}

function codeExecWire(
    provider: ProviderName,
    model: string
): string | undefined {
    const m = PROVIDERS.find((p) => p.id === provider)?.models.find(
        (x) => x.id === model
    );
    const wire = m?.tools?.codeExecution;
    return typeof wire === 'string' ? wire : undefined;
}

function readResult(
    blockType: string,
    toolUseId: string,
    content: unknown
): ResultRead {
    const r: ResultRead = { type: blockType, toolUseId, fileIds: [] };
    if (!content || typeof content !== 'object') return r;
    const c = content as Record<string, unknown>;
    const ctype = typeof c.type === 'string' ? c.type : '';
    if (ctype.endsWith('_tool_result_error')) {
        r.error =
            typeof c.error_code === 'string'
                ? c.error_code
                : 'tool execution error';
        return r;
    }
    if (typeof c.stdout === 'string') r.stdout = c.stdout;
    if (typeof c.stderr === 'string') r.stderr = c.stderr;
    if (typeof c.return_code === 'number') r.returnCode = c.return_code;
    if (Array.isArray(c.content)) {
        for (const o of c.content) {
            if (
                o &&
                typeof o === 'object' &&
                typeof (o as { file_id?: unknown }).file_id === 'string'
            ) {
                r.fileIds.push((o as { file_id: string }).file_id);
            }
        }
    }
    return r;
}

function scanResults(content: readonly unknown[]): ResultRead[] {
    const out: ResultRead[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as {
            type?: unknown;
            tool_use_id?: unknown;
            content?: unknown;
        };
        if (typeof b.type === 'string' && RESULT_BLOCK_TYPES.has(b.type)) {
            out.push(
                readResult(
                    b.type,
                    typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
                    b.content
                )
            );
        }
    }
    return out;
}

function assistantText(content: readonly unknown[]): string {
    let t = '';
    for (const block of content) {
        if (
            block &&
            typeof block === 'object' &&
            (block as { type?: unknown }).type === 'text'
        ) {
            const text = (block as { text?: unknown }).text;
            if (typeof text === 'string') t += text;
        }
    }
    return t;
}

function joinStdout(results: ResultRead[]): string {
    return results.map((r) => r.stdout ?? '').join('\n');
}

function summarizeResults(results: ResultRead[]): string[] {
    return results.map(
        (r) =>
            `${r.type}${r.error ? ` ERROR:${r.error}` : ''} files=${r.fileIds.length}` +
            (r.returnCode !== undefined ? ` rc=${r.returnCode}` : '')
    );
}

function dumpMessage(
    label: string,
    msg: { content: unknown; container?: { id?: string } | null }
): void {
    console.log(`  [dump ${label}] container.id=${msg.container?.id ?? null}`);
    console.log(JSON.stringify(msg.content, null, 2));
}

function codeExecTool(
    toolType: string
): Anthropic.Beta.Messages.BetaToolUnion[] {
    return [
        { type: toolType, name: 'code_execution' },
    ] as Anthropic.Beta.Messages.BetaToolUnion[];
}

async function betaTurn(
    client: Anthropic,
    model: string,
    toolType: string,
    content: string | Anthropic.Beta.Messages.BetaContentBlockParam[],
    opts: { container?: string } = {}
): Promise<Anthropic.Beta.Messages.BetaMessage> {
    return client.beta.messages.create({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content }],
        tools: codeExecTool(toolType),
        betas: [FILES_BETA],
        ...(opts.container ? { container: opts.container } : {}),
    });
}

async function downloadFile(
    client: Anthropic,
    fileId: string
): Promise<{
    filename: string;
    mediaType: string;
    sizeBytes: number;
    bytesWritten: number;
    savedTo: string;
}> {
    const meta = await client.beta.files.retrieveMetadata(fileId, {
        betas: [FILES_BETA],
    });
    const resp = await client.beta.files.download(fileId, {
        betas: [FILES_BETA],
    });
    const bytes = Buffer.from(await resp.arrayBuffer());
    const safe = meta.filename.replace(/[^A-Za-z0-9._-]/g, '_');
    const savedTo = join(OUT_DIR, `${fileId}_${safe}`);
    writeFileSync(savedTo, bytes);
    return {
        filename: meta.filename,
        mediaType: meta.mime_type,
        sizeBytes: meta.size_bytes,
        bytesWritten: bytes.byteLength,
        savedTo,
    };
}

async function deleteFileConfirm(
    client: Anthropic,
    fileId: string
): Promise<boolean> {
    await client.beta.files.delete(fileId, { betas: [FILES_BETA] });
    try {
        await client.beta.files.retrieveMetadata(fileId, {
            betas: [FILES_BETA],
        });
        return false;
    } catch {
        return true;
    }
}

function randomToken(): string {
    return `tok-${crypto.randomUUID().slice(0, 8)}`;
}

async function testCreate(
    client: Anthropic,
    model: string,
    toolType: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST create: do created files auto-return, and can we download + delete them? ==='
    );
    const prompt =
        'Make a bar chart of these sales numbers as a PNG file I can download: ' +
        'Widget A = 10, Widget B = 25, Widget C = 15. Also give me the underlying data as a CSV file.';
    const msg = await betaTurn(client, model, toolType, prompt);
    if (dump) dumpMessage('create', msg);
    const results = scanResults(msg.content);
    const fileIds = results.flatMap((r) => r.fileIds);
    console.log('result blocks:', summarizeResults(results));
    console.log('file_ids returned:', fileIds);
    console.log(
        '-> Q1: model self-exported downloadable files to $OUTPUT_DIR (no prompting) and they were captured:',
        fileIds.length > 0,
        '(only $OUTPUT_DIR is captured - cwd/tmp are not - but the model copies there on its own when the user wants a file)'
    );
    for (const id of fileIds) {
        const f = await downloadFile(client, id);
        console.log(
            `  downloaded ${id}: name=${f.filename} mime=${f.mediaType} size=${f.sizeBytes} wrote=${f.bytesWritten}B -> ${f.savedTo}`
        );
        const deleted = await deleteFileConfirm(client, id);
        console.log(
            `  deleted ${id} from Files API + confirmed gone: ${deleted}`
        );
    }
}

async function testPersist(
    client: Anthropic,
    model: string,
    toolType: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST persist: does a file survive a NEW request with no container reuse? ==='
    );
    const token = randomToken();
    const t1 = await betaTurn(
        client,
        model,
        toolType,
        `Use the code execution tool to write the exact text '${token}' (nothing else) into the file /tmp/test.txt. Then print the token you wrote.`
    );
    if (dump) dumpMessage('persist t1', t1);
    console.log(
        'turn1 wrote token:',
        token,
        ' container.id:',
        t1.container?.id ?? null
    );

    const t2 = await betaTurn(
        client,
        model,
        toolType,
        'Use the code execution tool to read /tmp/test.txt and print its contents verbatim. If it does not exist, print FILE_MISSING.'
    );
    if (dump) dumpMessage('persist t2', t2);
    const reply = assistantText(t2.content);
    const stdout = joinStdout(scanResults(t2.content));
    const survived = reply.includes(token) || stdout.includes(token);
    console.log('turn2 reply:', JSON.stringify(reply.slice(0, 200)));
    console.log(
        '-> Q2: file survived a fresh request WITHOUT container reuse:',
        survived,
        '(expected: false)'
    );
}

async function testReuse(
    client: Anthropic,
    model: string,
    toolType: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST reuse: does passing container.id carry the file into a later request? ==='
    );
    const token = randomToken();
    const t1 = await betaTurn(
        client,
        model,
        toolType,
        `Use the code execution tool to write the exact text '${token}' into /tmp/test.txt, then print it.`
    );
    if (dump) dumpMessage('reuse t1', t1);
    const containerId = t1.container?.id;
    console.log('turn1 token:', token, ' container.id:', containerId ?? null);
    if (!containerId) {
        console.log('-> no container id returned, cannot test reuse');
        return;
    }
    const t2 = await betaTurn(
        client,
        model,
        toolType,
        'Use the code execution tool to read /tmp/test.txt and print its contents verbatim. If it does not exist, print FILE_MISSING.',
        { container: containerId }
    );
    if (dump) dumpMessage('reuse t2', t2);
    const reply = assistantText(t2.content);
    const stdout = joinStdout(scanResults(t2.content));
    const survived = reply.includes(token) || stdout.includes(token);
    console.log('turn2 reply:', JSON.stringify(reply.slice(0, 200)));
    console.log(
        '-> file survived WITH container reuse:',
        survived,
        '(expected: true)'
    );
}

async function testReref(
    client: Anthropic,
    model: string,
    toolType: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST reref: can a created file_id be re-fed via container_upload (no byte re-upload)? ==='
    );
    const token = randomToken();
    const t1 = await betaTurn(
        client,
        model,
        toolType,
        `Use the bash code execution tool to write the exact text '${token}' into a file named report.txt inside the directory given by the $OUTPUT_DIR environment variable (reference the literal variable $OUTPUT_DIR). Do not print the contents.`
    );
    if (dump) dumpMessage('reref t1', t1);
    const fileIds = scanResults(t1.content).flatMap((r) => r.fileIds);
    console.log('turn1 file_ids:', fileIds);
    if (!fileIds.length) {
        console.log(
            '-> no file_id captured (file may have gone to a non-captured path); cannot test reref'
        );
        return;
    }
    const fileId = fileIds[0];
    const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [
        { type: 'container_upload', file_id: fileId },
        {
            type: 'text',
            text: 'A file was provided in the container input directory. Use the code execution tool to locate and read it, then print its contents verbatim.',
        },
    ];
    const t2 = await betaTurn(client, model, toolType, content);
    if (dump) dumpMessage('reref t2', t2);
    const reply = assistantText(t2.content);
    const stdout = joinStdout(scanResults(t2.content));
    const ok = reply.includes(token) || stdout.includes(token);
    console.log('turn2 reply:', JSON.stringify(reply.slice(0, 200)));
    console.log(
        '-> re-fed file via file_id (no byte re-upload):',
        ok,
        '(expected: true)'
    );
    for (const id of fileIds) {
        const deleted = await deleteFileConfirm(client, id);
        console.log(`  cleaned up ${id}: ${deleted}`);
    }
}

async function testInline(
    client: Anthropic,
    model: string,
    toolType: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST inline: retrieve a created file WITHOUT the Files API (base64 via stdout) ==='
    );
    const prompt =
        'Use the code execution tool to write a short 3-line haiku into a file named note.txt, ' +
        'then read note.txt back as bytes, base64-encode them, and print ONLY the base64 string ' +
        "on a single line prefixed with 'B64:'. Print nothing else.";
    const msg = await client.messages.create({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
        tools: [
            { type: toolType, name: 'code_execution' },
        ] as Anthropic.Messages.ToolUnion[],
    });
    if (dump) dumpMessage('inline', msg);
    const results = scanResults(msg.content);
    const haystack = `${joinStdout(results)}\n${assistantText(msg.content)}`;
    const match = haystack.match(/B64:\s*([A-Za-z0-9+/=\r\n]+)/);
    if (!match) {
        console.log(
            '-> no B64 payload found in stdout/text; model may not have printed it'
        );
        console.log(
            'stdout head:',
            JSON.stringify(joinStdout(results).slice(0, 200))
        );
        return;
    }
    const bytes = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
    const savedTo = join(OUT_DIR, 'inline-recovered.txt');
    writeFileSync(savedTo, bytes);
    console.log(
        `-> recovered ${bytes.byteLength}B from stdout base64 (NO Files API call) -> ${savedTo}`
    );
    console.log('   decoded:', JSON.stringify(bytes.toString('utf8')));
    console.log(
        '   note: result blocks still carried',
        results.flatMap((r) => r.fileIds).length,
        'file_id(s); those are retained by Anthropic regardless of whether we use the Files API'
    );
}

async function testStream(
    client: Anthropic,
    model: string,
    toolType: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST stream: do file_ids + container.id surface via STREAMING (beta)? ==='
    );
    const prompt =
        'Make a bar chart of these sales numbers as a PNG file I can download: ' +
        'Widget A = 10, Widget B = 25, Widget C = 15. Also give me the underlying data as a CSV file.';
    const stream = await client.messages.create(
        {
            model,
            max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }],
            tools: [
                { type: toolType, name: 'code_execution' },
            ] as Anthropic.Messages.ToolUnion[],
            stream: true,
        },
        { headers: { 'anthropic-beta': FILES_BETA } }
    );
    const fileIds: string[] = [];
    const carriers = new Set<string>();
    let containerId: string | null = null;
    let containerCarrier: string | null = null;
    for await (const event of stream) {
        if (dump) console.log('  event', event.type);
        if (event.type === 'message_start') {
            const id = event.message.container?.id;
            if (id && !containerId) {
                containerId = id;
                containerCarrier = 'message_start';
            }
        } else if (event.type === 'message_delta') {
            const id = event.delta.container?.id;
            if (id) {
                containerId = id;
                containerCarrier = 'message_delta';
            }
        } else if (event.type === 'content_block_start') {
            const found = scanResults([event.content_block]).flatMap(
                (r) => r.fileIds
            );
            if (found.length) {
                carriers.add('content_block_start');
                fileIds.push(...found);
            }
        }
    }
    console.log('file_ids via stream:', fileIds);
    console.log('file_id carrier event(s):', [...carriers]);
    console.log('container.id:', containerId, 'via', containerCarrier);
    console.log(
        '-> streaming surfaces file outputs AND container.id:',
        fileIds.length > 0 && !!containerId
    );
}

async function testUpload(
    apiKey: string,
    model: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST upload: does a user PDF attachment reach the model (via streamAnthropic)? ==='
    );
    const { streamAnthropic } =
        await import('../packages/courierai_ext/providers/anthropic');
    const pdfPath = join(import.meta.dirname, '..', '.tmp', 'test_pdf.pdf');
    const bytes = readFileSync(pdfPath);
    const base64 = bytes.toString('base64');
    const hash = `upload-${crypto.randomUUID().slice(0, 8)}`;
    const message: CourierAIMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        parts: [
            {
                type: 'text',
                text: 'What color does this PDF say? Reply with just the color word.',
                state: 'done',
            },
            {
                type: 'file',
                filename: 'test_pdf.pdf',
                mediaType: 'application/pdf',
                sizeBytes: bytes.byteLength,
                hash,
            },
        ],
        metadata: { createdAt: Date.now() },
    };
    let reply = '';
    for await (const chunk of streamAnthropic({
        apiKey,
        model,
        messages: [message],
        params: { maxTokens: 256 },
        blobs: { [hash]: { mediaType: 'application/pdf', base64 } },
    })) {
        if (dump) console.log('  chunk', chunk.type);
        if (chunk.type === 'text-delta') reply += chunk.delta;
    }
    console.log('reply:', JSON.stringify(reply.trim()));
    console.log('-> PDF attachment reached the model:', /orange/i.test(reply));
}

async function testEditPersist(
    client: Anthropic,
    model: string,
    toolType: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST editpersist: edit an attached file in the sandbox - does it change the durable file_id? (Anthropic) ==='
    );
    const token = randomToken();
    const t1 = await betaTurn(
        client,
        model,
        toolType,
        `Use the bash code execution tool to write the exact text '${token}' (and nothing else) into a file report.txt inside the directory given by the $OUTPUT_DIR environment variable (reference the literal variable $OUTPUT_DIR). Do not print the contents.`
    );
    if (dump) dumpMessage('editpersist t1', t1);
    const fileIds = scanResults(t1.content).flatMap((r) => r.fileIds);
    console.log('turn1 file_id(s):', fileIds);
    if (!fileIds.length) {
        console.log('-> no file_id captured; cannot test');
        return;
    }
    const fileId = fileIds[0];

    const token2 = randomToken();
    const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [
        { type: 'container_upload', file_id: fileId },
        {
            type: 'text',
            text: `A file was provided in the container input directory. Use the code execution tool to locate it, append the line '${token2}' to it IN PLACE, then read it back and print its contents. Also copy the edited version to a file edited.txt inside the directory given by $OUTPUT_DIR.`,
        },
    ];
    const t2 = await betaTurn(client, model, toolType, content);
    if (dump) dumpMessage('editpersist t2', t2);
    const newFileIds = scanResults(t2.content).flatMap((r) => r.fileIds);
    const reply = assistantText(t2.content);
    const stdout = joinStdout(scanResults(t2.content));
    console.log(
        'turn2 reply/stdout shows the edit:',
        (reply + stdout).includes(token2)
    );
    console.log('turn2 produced NEW file_id(s):', newFileIds);

    const resp = await client.beta.files.download(fileId, {
        betas: [FILES_BETA],
    });
    const origAfter = Buffer.from(await resp.arrayBuffer()).toString('utf8');
    console.log(
        'ORIGINAL file_id re-downloaded after edit:',
        JSON.stringify(origAfter)
    );
    console.log(
        '-> edit present in the ORIGINAL file_id:',
        origAfter.includes(token2),
        '(expected NO -> Anthropic Files API is also immutable; the edit lives in the container / a NEW file_id)'
    );

    for (const id of [fileId, ...newFileIds]) {
        await deleteFileConfirm(client, id).catch(() => false);
    }
}

async function testShell(
    client: OpenAI,
    model: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST shell: hosted shell tool, NO provisioned container - container_id + WHICH dirs get auto-tracked file_ids? ==='
    );
    const prompt =
        'Use the shell tool to create three small text files, each containing ' +
        'its own path as text:\n' +
        '  /mnt/data/in_data.txt\n' +
        '  /tmp/in_tmp.txt\n' +
        '  "$HOME/in_home.txt"\n' +
        'Then verify with: pwd; echo "HOME=$HOME"; ls -l /mnt/data/in_data.txt ' +
        '/tmp/in_tmp.txt "$HOME/in_home.txt". Reply with only the word DONE.';
    const response = await client.responses.create({
        model,
        input: prompt,
        max_output_tokens: 4096,
        tools: [
            {
                type: 'shell',
                environment: { type: 'container_auto', memory_limit: '1g' },
            },
        ],
        store: false,
    });
    if (dump) {
        console.log('  [dump shell] output:');
        console.log(JSON.stringify(response.output, null, 2));
    }

    let containerId: string | null = null;
    const commands: string[] = [];
    const exitCodes: Array<number | 'timeout'> = [];
    let stdout = '';
    let stderr = '';
    const annotationTypes: string[] = [];
    let assistantText = '';
    for (const item of response.output) {
        if (item.type === 'shell_call') {
            commands.push(...item.action.commands);
            const env = item.environment;
            if (env?.type === 'container_reference' && !containerId) {
                containerId = env.container_id;
            }
        } else if (item.type === 'shell_call_output') {
            for (const o of item.output) {
                stdout += o.stdout;
                stderr += o.stderr;
                exitCodes.push(
                    o.outcome.type === 'exit' ? o.outcome.exit_code : 'timeout'
                );
            }
        } else if (item.type === 'message') {
            for (const part of item.content) {
                if (part.type === 'output_text') {
                    assistantText += part.text;
                    for (const ann of part.annotations) {
                        annotationTypes.push(ann.type);
                    }
                }
            }
        }
    }

    console.log('shell commands run:', commands);
    console.log('exit codes:', exitCodes);
    console.log('stdout:', JSON.stringify(stdout.slice(0, 1500)));
    if (stderr.trim())
        console.log('stderr:', JSON.stringify(stderr.slice(0, 600)));
    console.log('assistant text:', JSON.stringify(assistantText.slice(0, 200)));
    console.log(
        'annotation types on output_text:',
        annotationTypes.length ? annotationTypes : '(none)'
    );
    console.log(
        '-> Q(a): container_id surfaced WITHOUT provisioning one:',
        !!containerId,
        containerId ? `(${containerId}, via shell_call.environment)` : ''
    );
    console.log(
        '-> Q(b): output files surfaced via annotations (code_interpreter-style container_file_citation):',
        annotationTypes.includes('container_file_citation'),
        '(expected false - shell does not cite files)'
    );

    if (!containerId) {
        console.log(
            '-> no container_id returned; cannot probe container files'
        );
        return;
    }

    const files: Array<{
        id: string;
        path: string;
        source: string;
        bytes: number;
    }> = [];
    for await (const f of client.containers.files.list(containerId)) {
        files.push({
            id: f.id,
            path: f.path,
            source: f.source,
            bytes: f.bytes,
        });
    }
    console.log(
        `-> Q(c): containers.files.list(${containerId}) returned ${files.length} file(s):`
    );
    for (const f of files) {
        console.log(
            `   ${f.id}  source=${f.source}  bytes=${f.bytes}  path=${f.path}`
        );
    }
    const trackedDirs = new Set(
        files.map((f) => f.path.replace(/\/[^/]*$/, '') || '/')
    );
    console.log(
        '-> WHERE auto-tracked (dirs of listed files):',
        [...trackedDirs],
        '\n   (only /mnt/data -> it IS the output dir like Anthropic $OUTPUT_DIR;',
        '/tmp + home present too -> whole FS is tracked, needs filtering)'
    );

    for (const f of files) {
        try {
            const resp = await client.containers.files.content.retrieve(f.id, {
                container_id: containerId,
            });
            const bytes = Buffer.from(await resp.arrayBuffer());
            const safe = (f.path.split('/').pop() || f.id).replace(
                /[^A-Za-z0-9._-]/g,
                '_'
            );
            const savedTo = join(OUT_DIR, `${f.id}_${safe}`);
            writeFileSync(savedTo, bytes);
            console.log(
                `   downloaded ${f.id}: ${bytes.byteLength}B -> ${savedTo}`
            );
        } catch (e) {
            console.log(
                `   download FAILED for ${f.id}:`,
                (e as Error).message
            );
        }
    }

    try {
        await client.containers.delete(containerId);
        console.log(
            '   deleted container via containers.delete (no per-file delete first)'
        );
    } catch (e) {
        console.log('   container delete FAILED:', (e as Error).message);
    }

    // DISAMBIGUATOR: is the CONTAINER itself gone, or just its files unaddressable?
    let containerGone = false;
    try {
        const c = await client.containers.retrieve(containerId);
        console.log(
            `   containers.retrieve after delete: STILL EXISTS (status=${c.status})`
        );
    } catch (e) {
        containerGone = true;
        console.log(`   containers.retrieve after delete: gone (${apiErr(e)})`);
    }

    // Re-run the same list we used in Q(c).
    try {
        const remaining: string[] = [];
        for await (const f of client.containers.files.list(containerId)) {
            remaining.push(f.id);
        }
        console.log(
            `   containers.files.list after delete: ${remaining.length} file(s)`,
            remaining
        );
    } catch (e) {
        console.log(
            `   containers.files.list after delete: threw (${apiErr(e)})`
        );
    }

    // Fetch each prior file id directly.
    let stillById = 0;
    for (const f of files) {
        try {
            await client.containers.files.retrieve(f.id, {
                container_id: containerId,
            });
            stillById++;
            console.log(`   file ${f.id}: STILL retrievable by id`);
            await client.containers.files
                .delete(f.id, { container_id: containerId })
                .catch(() => undefined);
        } catch (e) {
            console.log(
                `   file ${f.id}: not retrievable by id (${apiErr(e)})`
            );
        }
    }

    console.log(
        '-> Q(d): container gone after delete:',
        containerGone,
        '| files reachable by id:',
        stillById,
        '\n   (cfile ids are container-scoped with no global handle, so container-gone',
        '= unreachable = the observable purge; internal retention is provider policy,',
        'not API-visible)'
    );
}

async function testExpire(
    client: OpenAI,
    model: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST expire: reuse a container after >20min idle - does container_reference still work? ==='
    );
    const token = randomToken();
    const t1 = await client.responses.create({
        model,
        input: `Use the shell tool to write the exact text '${token}' to /mnt/data/marker.txt, then print DONE.`,
        max_output_tokens: 2048,
        tools: [
            {
                type: 'shell',
                environment: { type: 'container_auto', memory_limit: '1g' },
            },
        ],
        store: false,
    });
    if (dump) console.log(JSON.stringify(t1.output, null, 2));
    let containerId: string | null = null;
    for (const item of t1.output) {
        if (
            item.type === 'shell_call' &&
            item.environment?.type === 'container_reference'
        ) {
            containerId = item.environment.container_id;
        }
    }
    console.log(
        `turn1 wrote '${token}' to /mnt/data/marker.txt; container_id:`,
        containerId
    );
    if (!containerId) {
        console.log('-> no container_id from turn 1; cannot test expiry');
        return;
    }

    const waitMs = 21 * 60 * 1000;
    const wakeAt = new Date(Date.now() + waitMs).toLocaleTimeString();
    console.log(
        `sleeping ${waitMs / 60000} min (until ~${wakeAt}) to let the container go idle-expired...`
    );
    await new Promise((r) => setTimeout(r, waitMs));
    console.log(
        'woke up; reusing the (likely expired) container via container_reference...'
    );

    try {
        const t2 = await client.responses.create({
            model,
            input: 'Use the shell tool to read /mnt/data/marker.txt and print its contents verbatim. If it does not exist, print MISSING.',
            max_output_tokens: 2048,
            tools: [
                {
                    type: 'shell',
                    environment: {
                        type: 'container_reference',
                        container_id: containerId,
                    },
                },
            ],
            store: false,
        });
        if (dump) console.log(JSON.stringify(t2.output, null, 2));
        let t2Container: string | null = null;
        let stdout = '';
        let text = '';
        for (const item of t2.output) {
            if (
                item.type === 'shell_call' &&
                item.environment?.type === 'container_reference'
            ) {
                t2Container = item.environment.container_id;
            } else if (item.type === 'shell_call_output') {
                for (const o of item.output) stdout += o.stdout;
            } else if (item.type === 'message') {
                for (const part of item.content) {
                    if (part.type === 'output_text') text += part.text;
                }
            }
        }
        const survived = (stdout + text).includes(token);
        console.log(
            'turn2 SUCCEEDED. container_id returned:',
            t2Container,
            '(same as turn1?',
            t2Container === containerId,
            ')'
        );
        console.log('turn2 stdout:', JSON.stringify(stdout.slice(0, 300)));
        console.log('turn2 text:', JSON.stringify(text.slice(0, 200)));
        console.log(
            '-> expired container_reference accepted AND file survived:',
            survived,
            '\n   (SUCCEEDED+MISSING -> reference accepted but state lost; SUCCEEDED+survived -> not actually expired)'
        );
    } catch (e) {
        console.log('turn2 FAILED:', apiErr(e), '-', (e as Error).message);
        console.log(
            '-> expired container_reference REJECTED -> must catch this and fall back to a fresh container_auto (re-attaching files in PFS-ON).'
        );
    }

    await client.containers.delete(containerId).catch(() => undefined);
}

async function testRoundtrip(
    client: OpenAI,
    model: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST roundtrip: create -> download -> /v1/files upload -> attach via file_ids -> can the model read/EDIT it? ==='
    );
    const token = randomToken();
    const t1 = await client.responses.create({
        model,
        input: `Use the shell tool to write the exact text '${token}' to /mnt/data/data.txt, then print DONE.`,
        max_output_tokens: 2048,
        tools: [
            {
                type: 'shell',
                environment: { type: 'container_auto', memory_limit: '1g' },
            },
        ],
        store: false,
    });
    let containerId1: string | null = null;
    for (const item of t1.output) {
        if (
            item.type === 'shell_call' &&
            item.environment?.type === 'container_reference'
        ) {
            containerId1 = item.environment.container_id;
        }
    }
    if (!containerId1) {
        console.log('-> turn1 produced no container; abort');
        return;
    }
    const created = [];
    for await (const f of client.containers.files.list(containerId1)) {
        if (f.source === 'assistant') created.push(f);
    }
    if (!created.length) {
        console.log('-> turn1 created no assistant file; abort');
        return;
    }
    const src = created[0];
    const resp = await client.containers.files.content.retrieve(src.id, {
        container_id: containerId1,
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    console.log(
        `turn1: created ${src.path} (${buf.byteLength}B), token=${token}`
    );

    const file = await toFile(buf, 'data.txt', { type: 'text/plain' });
    const uploaded = await client.files.create({ file, purpose: 'user_data' });
    console.log('uploaded to /v1/files:', uploaded.id);

    const token2 = randomToken();
    const t2 = await client.responses.create({
        model,
        input:
            'A file was attached to this container. Use the shell tool to do ALL of the following, printing each step result clearly:\n' +
            "1) locate it: find / -name 'data.txt' -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null ; print the path(s).\n" +
            '2) ls -l that path (show permissions + owner).\n' +
            '3) cat that path.\n' +
            `4) try to append the line '${token2}' to that file IN PLACE (echo '${token2}' >> <path>), then cat it again; report VERBATIM whether the append worked or errored (e.g. Permission denied).\n` +
            `5) copy it to /mnt/data/data_edited.txt, append '${token2}' to the COPY, then cat the copy.\n` +
            'Finally print DONE.',
        max_output_tokens: 4096,
        tools: [
            {
                type: 'shell',
                environment: {
                    type: 'container_auto',
                    memory_limit: '1g',
                    file_ids: [uploaded.id],
                },
            },
        ],
        store: false,
    });
    if (dump) console.log(JSON.stringify(t2.output, null, 2));
    let containerId2: string | null = null;
    let stdout = '';
    let text = '';
    for (const item of t2.output) {
        if (
            item.type === 'shell_call' &&
            item.environment?.type === 'container_reference'
        ) {
            containerId2 = item.environment.container_id;
        } else if (item.type === 'shell_call_output') {
            for (const o of item.output) {
                stdout += o.stdout;
                if (o.stderr) stdout += `\n[stderr] ${o.stderr}`;
            }
        } else if (item.type === 'message') {
            for (const part of item.content) {
                if (part.type === 'output_text') text += part.text;
            }
        }
    }
    console.log('--- turn2 shell stdout ---');
    console.log(stdout.slice(0, 2500));
    console.log('--- turn2 assistant text ---');
    console.log(text.slice(0, 500));
    let editedAttachedId: string | null = null;
    if (containerId2) {
        console.log('container2 files (note source of the attached file):');
        for await (const f of client.containers.files.list(containerId2)) {
            console.log(`   ${f.id}  source=${f.source}  path=${f.path}`);
            if (f.source === 'user') editedAttachedId = f.id;
        }
    }
    console.log(
        '-> READ the stdout: where the attached file landed, its ls -l perms, whether the IN-PLACE append worked (read-only?), and whether the /mnt/data copy+edit worked.'
    );

    let editInContainer = false;
    if (editedAttachedId && containerId2) {
        const cbytes = Buffer.from(
            await (
                await client.containers.files.content.retrieve(
                    editedAttachedId,
                    { container_id: containerId2 }
                )
            ).arrayBuffer()
        ).toString('utf8');
        editInContainer = cbytes.includes(token2);
        console.log(
            'attached file CONTAINER copy after edit:',
            JSON.stringify(cbytes)
        );
    }

    let fileIdContent: string | null = null;
    let fileIdErr: string | null = null;
    try {
        fileIdContent = Buffer.from(
            await (await client.files.content(uploaded.id)).arrayBuffer()
        ).toString('utf8');
    } catch (e) {
        fileIdErr = apiErr(e);
    }
    if (fileIdErr) {
        console.log('/v1/files file_id NOT downloadable:', fileIdErr);
    } else {
        console.log(
            '/v1/files file_id re-downloaded after edit:',
            JSON.stringify(fileIdContent)
        );
    }
    console.log(
        '-> edit in CONTAINER copy:',
        editInContainer,
        '| /v1/files file_id downloadable:',
        !fileIdErr,
        fileIdErr ? '' : `| edit in file_id: ${fileIdContent?.includes(token2)}`
    );

    await client.files.delete(uploaded.id).catch(() => undefined);
    await client.containers.delete(containerId1).catch(() => undefined);
    if (containerId2 && containerId2 !== containerId1) {
        await client.containers.delete(containerId2).catch(() => undefined);
    }
}

async function testAttachWarm(
    client: OpenAI,
    model: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST attachwarm: can we attach a file to a WARM (already-created) container, and does the model see it on reuse? ==='
    );
    const token1 = randomToken();
    const t1 = await client.responses.create({
        model,
        input: `Use the shell tool to write '${token1}' to /mnt/data/orig.txt, then print DONE.`,
        max_output_tokens: 2048,
        tools: [
            {
                type: 'shell',
                environment: { type: 'container_auto', memory_limit: '1g' },
            },
        ],
        store: false,
    });
    let containerId: string | null = null;
    for (const item of t1.output) {
        if (
            item.type === 'shell_call' &&
            item.environment?.type === 'container_reference'
        ) {
            containerId = item.environment.container_id;
        }
    }
    if (!containerId) {
        console.log('-> turn1 produced no container; abort');
        return;
    }
    console.log('turn1 container:', containerId);

    const token2 = randomToken();
    const file = await toFile(
        Buffer.from(`ATTACHED-${token2}`),
        'attached.txt',
        {
            type: 'text/plain',
        }
    );
    const uploaded = await client.files.create({ file, purpose: 'user_data' });
    console.log('uploaded to /v1/files:', uploaded.id);

    let attachedPath: string | null = null;
    try {
        const created = await client.containers.files.create(containerId, {
            file_id: uploaded.id,
        });
        attachedPath = created.path;
        console.log(
            `containers.files.create on WARM container OK: ${created.id} source=${created.source} path=${created.path}`
        );
    } catch (e) {
        console.log(
            'containers.files.create on WARM container FAILED:',
            apiErr(e)
        );
    }

    const t2 = await client.responses.create({
        model,
        input: `Use the shell tool: run \`ls -l /mnt/data\`, then cat every file in /mnt/data. Report whether any file contains 'ATTACHED-${token2}'. Print DONE.`,
        max_output_tokens: 4096,
        tools: [
            {
                type: 'shell',
                environment: {
                    type: 'container_reference',
                    container_id: containerId,
                },
            },
        ],
        store: false,
    });
    if (dump) console.log(JSON.stringify(t2.output, null, 2));
    let stdout = '';
    let text = '';
    for (const item of t2.output) {
        if (item.type === 'shell_call_output') {
            for (const o of item.output) stdout += o.stdout;
        } else if (item.type === 'message') {
            for (const part of item.content) {
                if (part.type === 'output_text') text += part.text;
            }
        }
    }
    console.log('--- turn2 stdout ---');
    console.log(stdout.slice(0, 2000));
    const sees = (stdout + text).includes(`ATTACHED-${token2}`);
    console.log('container files now:');
    for await (const f of client.containers.files.list(containerId)) {
        console.log(`   ${f.id}  source=${f.source}  path=${f.path}`);
    }
    console.log(
        '-> attached to warm container:',
        !!attachedPath,
        '| model SEES the attached file on container_reference reuse:',
        sees
    );

    await client.files.delete(uploaded.id).catch(() => undefined);
    await client.containers.delete(containerId).catch(() => undefined);
}

async function runOpenAI(
    apiKey: string,
    model: string,
    dump: boolean,
    tests: OpenAITestName[]
): Promise<void> {
    const client = new OpenAI({ apiKey });
    console.log(`=== file-testing: openai / ${model} ===`);
    console.log(`output dir: ${OUT_DIR}`);
    const runners: Record<OpenAITestName, () => Promise<void>> = {
        shell: () => testShell(client, model, dump),
        expire: () => testExpire(client, model, dump),
        roundtrip: () => testRoundtrip(client, model, dump),
        attachwarm: () => testAttachWarm(client, model, dump),
    };
    for (const t of tests) await runners[t]();
}

function summarizeGoogleParts(parts: GooglePart[]): string[] {
    return parts.map((p) => {
        if (p.executableCode) {
            return `executableCode lang=${p.executableCode.language} chars=${p.executableCode.code?.length ?? 0}`;
        }
        if (p.codeExecutionResult) {
            return `codeExecutionResult outcome=${p.codeExecutionResult.outcome} outChars=${p.codeExecutionResult.output?.length ?? 0}`;
        }
        if (p.inlineData) {
            return `inlineData mime=${p.inlineData.mimeType} displayName=${p.inlineData.displayName ?? '(none)'} b64chars=${p.inlineData.data?.length ?? 0}`;
        }
        if (p.fileData) return `fileData uri=${p.fileData.fileUri}`;
        if (p.text != null) {
            return `${p.thought ? 'thought' : 'text'} chars=${p.text.length}`;
        }
        return `other keys=${Object.keys(p).join(',')}`;
    });
}

function truncateGoogleParts(parts: GooglePart[]): unknown[] {
    return parts.map((p) =>
        p.inlineData?.data
            ? {
                  ...p,
                  inlineData: {
                      ...p.inlineData,
                      data: `${p.inlineData.data.slice(0, 64)}... (${p.inlineData.data.length} b64 chars)`,
                  },
              }
            : p
    );
}

function googleText(parts: GooglePart[]): string {
    return parts
        .filter((p) => p.text != null && !p.thought)
        .map((p) => p.text)
        .join('');
}

function googleStdout(parts: GooglePart[]): string {
    return parts.map((p) => p.codeExecutionResult?.output ?? '').join('\n');
}

function extFromMime(mime: string): string {
    if (mime.includes('png')) return '.png';
    if (mime.includes('jpeg')) return '.jpg';
    if (mime.includes('csv')) return '.csv';
    if (mime.includes('text')) return '.txt';
    return '.bin';
}

async function uploadGoogleTestFile(
    client: GoogleGenAI,
    bytes: Buffer,
    mimeType: string,
    displayName: string
): Promise<GoogleFile> {
    let file = await client.files.upload({
        file: new Blob([new Uint8Array(bytes)], { type: mimeType }),
        config: { mimeType, displayName },
    });
    let polls = 0;
    while (file.state === FileState.PROCESSING && file.name) {
        if (++polls > 60) {
            throw new Error(`${displayName} still PROCESSING after 60s`);
        }
        await new Promise((r) => setTimeout(r, 1000));
        file = await client.files.get({ name: file.name });
    }
    if (file.state === FileState.FAILED) {
        throw new Error(`Google failed to process ${displayName}`);
    }
    return file;
}

async function testGoogleCreate(
    client: GoogleGenAI,
    model: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST create (google): do code-exec outputs surface as inlineData parts, with what metadata, and via streaming? ==='
    );
    const prompt =
        'Make a bar chart of these sales numbers as a PNG file I can download: ' +
        'Widget A = 10, Widget B = 25, Widget C = 15. Also give me the underlying data as a CSV file.';
    const res = await client.models.generateContent({
        model,
        contents: prompt,
        config: { tools: [{ codeExecution: {} }], maxOutputTokens: 8192 },
    });
    const parts = res.candidates?.[0]?.content?.parts ?? [];
    if (dump) {
        console.log('  [dump create] parts:');
        console.log(JSON.stringify(truncateGoogleParts(parts), null, 2));
    }
    console.log('parts:', summarizeGoogleParts(parts));
    const inlineParts = parts.filter((p) => p.inlineData?.data);
    console.log(
        '-> Q1: generated files surfaced as inlineData parts:',
        inlineParts.length,
        '| mimes:',
        inlineParts.map((p) => p.inlineData?.mimeType),
        '| displayNames:',
        inlineParts.map((p) => p.inlineData?.displayName ?? '(none)')
    );
    console.log(
        '-> Q2: non-image file (CSV) came back as a part:',
        inlineParts.some((p) => !p.inlineData?.mimeType?.startsWith('image/')),
        '| CSV content present in text/stdout instead:',
        /Widget A/.test(googleText(parts) + googleStdout(parts))
    );
    inlineParts.forEach((p, i) => {
        const data = p.inlineData?.data;
        const mime = p.inlineData?.mimeType ?? '';
        if (!data) return;
        const savedTo = join(OUT_DIR, `google-create-${i}${extFromMime(mime)}`);
        const bytes = Buffer.from(data, 'base64');
        writeFileSync(savedTo, bytes);
        console.log(
            `  saved inlineData[${i}]: ${bytes.byteLength}B -> ${savedTo}`
        );
    });

    console.log('streaming the same prompt...');
    const stream = await client.models.generateContentStream({
        model,
        contents: prompt,
        config: { tools: [{ codeExecution: {} }], maxOutputTokens: 8192 },
    });
    let chunkIdx = 0;
    const inlineHits: string[] = [];
    for await (const chunk of stream) {
        for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
            if (p.inlineData?.data) {
                inlineHits.push(
                    `chunk ${chunkIdx}: mime=${p.inlineData.mimeType} b64chars=${p.inlineData.data.length}`
                );
            }
        }
        chunkIdx++;
    }
    console.log(
        `-> Q3: inlineData arrives via STREAMING: ${inlineHits.length > 0} (${chunkIdx} chunks)`,
        inlineHits.length ? inlineHits : ''
    );
}

async function testGoogleRead(
    client: GoogleGenAI,
    model: string,
    dump: boolean
): Promise<void> {
    console.log(
        "\n=== TEST read (google): can code exec READ an attached file's raw bytes (inlineData vs fileData)? ==="
    );
    const token = randomToken();
    const csv = `id,secret\n1,${token}\n`;
    const csvBytes = Buffer.from(csv, 'utf8');
    const md5 = createHash('md5').update(csvBytes).digest('hex');
    const prompt =
        'A CSV file is attached. Use the code execution tool to: ' +
        '1) compute the MD5 hex digest of the attached file RAW BYTES and print it, ' +
        '2) print the value in the secret column verbatim.';
    console.log(`csv: ${csvBytes.byteLength}B, token=${token}, md5=${md5}`);

    const runVariant = async (
        label: string,
        attachment: GooglePart
    ): Promise<void> => {
        try {
            const res = await client.models.generateContent({
                model,
                contents: [
                    { role: 'user', parts: [attachment, { text: prompt }] },
                ],
                config: {
                    tools: [{ codeExecution: {} }],
                    maxOutputTokens: 8192,
                },
            });
            const parts = res.candidates?.[0]?.content?.parts ?? [];
            if (dump) {
                console.log(`  [dump read ${label}] parts:`);
                console.log(
                    JSON.stringify(truncateGoogleParts(parts), null, 2)
                );
            }
            const haystack = googleText(parts) + googleStdout(parts);
            console.log(`${label}: parts:`, summarizeGoogleParts(parts));
            console.log(
                `-> ${label}: sandbox had the RAW BYTES (md5 match): ${haystack.includes(md5)} | content visible (token echoed): ${haystack.includes(token)}`
            );
        } catch (e) {
            console.log(`-> ${label}: request FAILED:`, (e as Error).message);
        }
    };

    await runVariant('inlineData', {
        inlineData: { mimeType: 'text/csv', data: csvBytes.toString('base64') },
    });

    const file = await uploadGoogleTestFile(
        client,
        csvBytes,
        'text/csv',
        'read-probe.csv'
    );
    console.log(`uploaded to Files API: ${file.name} uri=${file.uri}`);
    await runVariant('fileData', {
        fileData: { fileUri: file.uri ?? '', mimeType: 'text/csv' },
    });
    if (file.name) {
        await client.files.delete({ name: file.name }).catch(() => undefined);
    }
}

async function testGoogleTokens(
    client: GoogleGenAI,
    model: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST tokens (google): is a fileData attachment tokenized into the prompt even when code exec consumes it? ==='
    );
    const lines = ['id,value'];
    let size = lines[0].length + 1;
    let rows = 0;
    while (size < 1024 * 1024) {
        const line = `${rows},${(Math.random() * 1e9).toFixed(0)}`;
        lines.push(line);
        size += line.length + 1;
        rows++;
    }
    const csvBytes = Buffer.from(lines.join('\n'), 'utf8');
    const prompt =
        'Use the code execution tool to count the data rows in the attached CSV file ' +
        '(excluding the header) and print only the count.';
    console.log(`fat csv: ${csvBytes.byteLength}B, ${rows} data rows`);

    const promptOnly = await client.models.countTokens({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    console.log('countTokens (prompt only):', promptOnly.totalTokens);

    const file = await uploadGoogleTestFile(
        client,
        csvBytes,
        'text/csv',
        'tokens-probe.csv'
    );
    console.log(`uploaded to Files API: ${file.name}`);
    const fileParts: GooglePart[] = [
        { fileData: { fileUri: file.uri ?? '', mimeType: 'text/csv' } },
        { text: prompt },
    ];
    const withFile = await client.models.countTokens({
        model,
        contents: [{ role: 'user', parts: fileParts }],
    });
    console.log('countTokens (prompt + fileData):', withFile.totalTokens);

    try {
        const res = await client.models.generateContent({
            model,
            contents: [{ role: 'user', parts: fileParts }],
            config: { tools: [{ codeExecution: {} }], maxOutputTokens: 8192 },
        });
        const parts = res.candidates?.[0]?.content?.parts ?? [];
        if (dump) {
            console.log('  [dump tokens] usageMetadata:');
            console.log(JSON.stringify(res.usageMetadata, null, 2));
        }
        const usage = res.usageMetadata;
        const haystack = googleText(parts) + googleStdout(parts);
        console.log(
            'generateContent (code exec ON, with file): promptTokenCount =',
            usage?.promptTokenCount,
            '| toolUsePromptTokenCount =',
            usage?.toolUsePromptTokenCount,
            '| totalTokenCount =',
            usage?.totalTokenCount
        );
        console.log(
            'model counted the rows correctly (file readable):',
            haystack.includes(String(rows))
        );
        const diff =
            (usage?.promptTokenCount ?? 0) - (promptOnly.totalTokens ?? 0);
        console.log(
            `-> file cost ~${diff} prompt tokens (expected ~${Math.round(csvBytes.byteLength / 4)} if fully tokenized, ~0 if sandbox-only)`
        );
    } catch (e) {
        console.log('generateContent FAILED:', (e as Error).message);
    }
    if (file.name) {
        await client.files.delete({ name: file.name }).catch(() => undefined);
    }
}

function makeWav(totalBytes: number): Buffer {
    const dataSize = totalBytes - 44;
    const buf = Buffer.alloc(totalBytes);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(16000, 24);
    buf.writeUInt32LE(32000, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);
    return buf;
}

async function testGoogleLimit(
    client: GoogleGenAI,
    model: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST limit (google): where does the inline (non-Files-API) request size cap actually sit? ==='
    );
    const attempt = async (targetB64MB: number): Promise<void> => {
        const rawBytes = Math.floor(targetB64MB * 1024 * 1024 * 0.75);
        const wav = makeWav(rawBytes);
        const b64 = wav.toString('base64');
        const durationSec = Math.round((rawBytes - 44) / 32000);
        console.log(
            `attempt: ${rawBytes}B raw silence WAV (~${durationSec}s) -> ${b64.length} b64 chars (~${targetB64MB}MB request)`
        );
        try {
            const res = await client.models.generateContent({
                model,
                contents: [
                    {
                        role: 'user',
                        parts: [
                            {
                                inlineData: {
                                    mimeType: 'audio/wav',
                                    data: b64,
                                },
                            },
                            {
                                text: 'How many seconds long is this audio clip? Reply with just a number.',
                            },
                        ],
                    },
                ],
                config: { maxOutputTokens: 64 },
            });
            const parts = res.candidates?.[0]?.content?.parts ?? [];
            if (dump) {
                console.log('  [dump limit] usageMetadata:');
                console.log(JSON.stringify(res.usageMetadata, null, 2));
            }
            console.log(
                `  ACCEPTED. reply=${JSON.stringify(googleText(parts).trim().slice(0, 80))} promptTokenCount=${res.usageMetadata?.promptTokenCount}`
            );
        } catch (e) {
            console.log('  REJECTED:', (e as Error).message);
        }
    };
    await attempt(19);
    console.log(
        '-> SETTLED 2026-06-10 (gemini-3.5-flash + video-understanding doc): inline hard',
        'cap is <100MB; >20MB total request is "always use the Files API" GUIDANCE, not a',
        'gate (52.5MB raw was accepted once during discovery - do NOT re-probe above the',
        'guidance, only this in-guidance 19MB sanity check remains).'
    );
}

async function runGoogle(
    apiKey: string,
    model: string,
    dump: boolean,
    tests: GoogleTestName[]
): Promise<void> {
    const client = new GoogleGenAI({ apiKey });
    console.log(`=== file-testing: google / ${model} ===`);
    console.log(`output dir: ${OUT_DIR}`);
    const runners: Record<GoogleTestName, () => Promise<void>> = {
        create: () => testGoogleCreate(client, model, dump),
        read: () => testGoogleRead(client, model, dump),
        tokens: () => testGoogleTokens(client, model, dump),
        limit: () => testGoogleLimit(client, model, dump),
    };
    for (const t of tests) await runners[t]();
}

const OR_BASE = 'https://openrouter.ai/api/v1';
const OR_PDF_QUESTION =
    'What color does this PDF say? Reply with just the color word.';
const OR_PDF_FOLLOWUP =
    'Quote verbatim the sentence from the PDF that mentions the color.';
const OR_IMAGE_QUESTION =
    'In a few words, what is the main subject of this image?';
const OR_IMAGE_EXPECT = /sunset|sunrise|ocean|sea|beach|sky|horizon|waves?/i;

type OREngine = 'native' | 'cloudflare-ai';

interface ORCallResult {
    ok: boolean;
    status: number;
    ms: number;
    json: unknown;
    errorText: string | null;
}

function asObj(v: unknown): Record<string, unknown> | null {
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

async function orPost(
    apiKey: string,
    path: string,
    body: Record<string, unknown>
): Promise<ORCallResult> {
    const started = Date.now();
    const res = await fetch(`${OR_BASE}${path}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const ms = Date.now() - started;
    const text = await res.text();
    let json: unknown = null;
    try {
        json = JSON.parse(text);
    } catch {
        json = null;
    }
    const bodyError = asObj(asObj(json)?.error);
    const ok = res.ok && !bodyError;
    return {
        ok,
        status: res.status,
        ms,
        json,
        errorText: ok
            ? null
            : (typeof bodyError?.message === 'string'
                  ? bodyError.message
                  : text
              ).slice(0, 800),
    };
}

function orPlugins(engine?: OREngine): Record<string, unknown> {
    return engine ? { plugins: [{ id: 'file-parser', pdf: { engine } }] } : {};
}

function orPdfDataUrl(): string {
    const bytes = readFileSync(
        join(import.meta.dirname, '..', '.tmp', 'test_pdf.pdf')
    );
    return `data:application/pdf;base64,${bytes.toString('base64')}`;
}

function orImageDataUrl(): string {
    const bytes = readFileSync(
        join(
            import.meta.dirname,
            '..',
            'tests',
            'e2e',
            'files',
            'vision-test.jpg'
        )
    );
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

function orResponsesPdfBody(
    model: string,
    pdfUrl: string,
    engine?: OREngine,
    question: string = OR_PDF_QUESTION
): Record<string, unknown> {
    return {
        model,
        input: [
            {
                role: 'user',
                content: [
                    { type: 'input_text', text: question },
                    {
                        type: 'input_file',
                        filename: 'test_pdf.pdf',
                        file_data: pdfUrl,
                    },
                ],
            },
        ],
        max_output_tokens: 1024,
        stream: false,
        ...orPlugins(engine),
    };
}

function orCCPdfMessage(
    pdfUrl: string,
    question: string = OR_PDF_QUESTION
): Record<string, unknown> {
    return {
        role: 'user',
        content: [
            { type: 'text', text: question },
            {
                type: 'file',
                file: { filename: 'test_pdf.pdf', file_data: pdfUrl },
            },
        ],
    };
}

function orCCBody(
    model: string,
    messages: unknown[],
    engine?: OREngine
): Record<string, unknown> {
    return {
        model,
        messages,
        max_tokens: 1024,
        stream: false,
        ...orPlugins(engine),
    };
}

function orResponsesText(resp: unknown): string {
    let out = '';
    const output = asObj(resp)?.output;
    if (!Array.isArray(output)) return out;
    for (const item of output) {
        const it = asObj(item);
        if (it?.type !== 'message' || !Array.isArray(it.content)) continue;
        for (const part of it.content) {
            const p = asObj(part);
            if (p?.type === 'output_text' && typeof p.text === 'string') {
                out += p.text;
            }
        }
    }
    return out;
}

function orResponsesMessageItems(resp: unknown): unknown[] {
    const output = asObj(resp)?.output;
    if (!Array.isArray(output)) return [];
    return output.filter((item) => asObj(item)?.type === 'message');
}

function orResponsesAnnotations(resp: unknown): unknown[] {
    const found: unknown[] = [];
    const output = asObj(resp)?.output;
    if (!Array.isArray(output)) return found;
    for (const item of output) {
        const it = asObj(item);
        if (!it) continue;
        if (Array.isArray(it.annotations)) found.push(...it.annotations);
        if (!Array.isArray(it.content)) continue;
        for (const part of it.content) {
            const p = asObj(part);
            if (p && Array.isArray(p.annotations)) found.push(...p.annotations);
        }
    }
    return found;
}

function orCCText(resp: unknown): string {
    const choices = asObj(resp)?.choices;
    if (!Array.isArray(choices)) return '';
    const msg = asObj(asObj(choices[0])?.message);
    return typeof msg?.content === 'string' ? msg.content : '';
}

function orCCAnnotations(resp: unknown): unknown[] {
    const choices = asObj(resp)?.choices;
    if (!Array.isArray(choices)) return [];
    const msg = asObj(asObj(choices[0])?.message);
    return Array.isArray(msg?.annotations) ? msg.annotations : [];
}

function orAnnotationSummary(anns: unknown[]): string {
    if (!anns.length) return '(none)';
    const counts = new Map<string, number>();
    let fileChars = 0;
    for (const a of anns) {
        const o = asObj(a);
        const t = typeof o?.type === 'string' ? o.type : 'unknown';
        counts.set(t, (counts.get(t) ?? 0) + 1);
        const file = asObj(o?.file);
        if (Array.isArray(file?.content)) {
            for (const c of file.content) {
                const co = asObj(c);
                if (typeof co?.text === 'string') fileChars += co.text.length;
            }
        }
    }
    const parts = [...counts].map(([t, n]) => `${t} x${n}`);
    return (
        parts.join(', ') +
        (fileChars ? ` (parsed file content ~${fileChars} chars)` : '')
    );
}

function orUsageSummary(resp: unknown): string {
    const u = asObj(asObj(resp)?.usage);
    if (!u) return 'usage=(none)';
    const input = u.input_tokens ?? u.prompt_tokens;
    const output = u.output_tokens ?? u.completion_tokens;
    return `usage in=${input} out=${output}`;
}

function orLogFailure(label: string, call: ORCallResult): void {
    console.log(
        `${label}: FAILED HTTP ${call.status} (${call.ms}ms):`,
        call.errorText
    );
}

async function testORImage(
    apiKey: string,
    model: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST image (openrouter): does an input_image data URL reach the model via the responses API? ==='
    );
    const call = await orPost(apiKey, '/responses', {
        model,
        input: [
            {
                role: 'user',
                content: [
                    { type: 'input_text', text: OR_IMAGE_QUESTION },
                    {
                        type: 'input_image',
                        image_url: orImageDataUrl(),
                        detail: 'auto',
                    },
                ],
            },
        ],
        max_output_tokens: 512,
        stream: false,
    });
    if (!call.ok) {
        orLogFailure('image', call);
        return;
    }
    if (dump) console.log(JSON.stringify(asObj(call.json)?.output, null, 2));
    const reply = orResponsesText(call.json);
    console.log(`reply (${call.ms}ms, ${orUsageSummary(call.json)}):`);
    console.log(' ', JSON.stringify(reply.trim().slice(0, 200)));
    console.log(
        '-> model saw the image (sunset/ocean mentioned):',
        OR_IMAGE_EXPECT.test(reply)
    );
}

async function testORPdf(
    apiKey: string,
    model: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST pdf (openrouter): does an input_file PDF reach the model with engine=native? ==='
    );
    const call = await orPost(
        apiKey,
        '/responses',
        orResponsesPdfBody(model, orPdfDataUrl(), 'native')
    );
    if (!call.ok) {
        orLogFailure('pdf', call);
        return;
    }
    if (dump) console.log(JSON.stringify(asObj(call.json)?.output, null, 2));
    const reply = orResponsesText(call.json);
    const anns = orResponsesAnnotations(call.json);
    console.log(`reply (${call.ms}ms, ${orUsageSummary(call.json)}):`);
    console.log(' ', JSON.stringify(reply.trim().slice(0, 200)));
    console.log('annotations:', orAnnotationSummary(anns));
    console.log('-> model read the PDF (said orange):', /orange/i.test(reply));
}

async function testORFallback(
    apiKey: string,
    textModel: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST fallback (openrouter): text-only model - is cloudflare-ai fallback built in, and does engine=native error? ==='
    );
    console.log(`text-only model: ${textModel}`);
    const pdfUrl = orPdfDataUrl();
    const variants: Array<{ label: string; engine?: OREngine }> = [
        { label: 'no plugin (docs say native-else-cloudflare default)' },
        { label: 'engine=native (expect a clear error)', engine: 'native' },
        {
            label: 'engine=cloudflare-ai (expect success)',
            engine: 'cloudflare-ai',
        },
    ];
    for (const v of variants) {
        const call = await orPost(
            apiKey,
            '/responses',
            orResponsesPdfBody(textModel, pdfUrl, v.engine)
        );
        if (!call.ok) {
            console.log(
                `${v.label}: REJECTED HTTP ${call.status} (${call.ms}ms):`,
                call.errorText
            );
            continue;
        }
        if (dump)
            console.log(JSON.stringify(asObj(call.json)?.output, null, 2));
        const reply = orResponsesText(call.json);
        console.log(
            `${v.label}: ACCEPTED (${call.ms}ms, ${orUsageSummary(call.json)})` +
                ` correct=${/orange/i.test(reply)} reply=${JSON.stringify(reply.trim().slice(0, 120))}`
        );
    }
    console.log(
        '-> if no-plugin ACCEPTED+correct on a text-only model, the cloudflare fallback is built in;',
        'if engine=native REJECTED, "Provider native only" mode surfaces a real API error we can show.'
    );
}

async function testORAnnotations(
    apiKey: string,
    model: string,
    citeModel: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST annotations (openrouter): which annotation types come back per endpoint x engine? ==='
    );
    const pdfUrl = orPdfDataUrl();
    const probes: Array<{
        label: string;
        endpoint: '/responses' | '/chat/completions';
        model: string;
        engine: OREngine;
    }> = [
        {
            label: 'responses + native',
            endpoint: '/responses',
            model,
            engine: 'native',
        },
        {
            label: 'responses + cloudflare-ai',
            endpoint: '/responses',
            model,
            engine: 'cloudflare-ai',
        },
        {
            label: 'cc + native',
            endpoint: '/chat/completions',
            model,
            engine: 'native',
        },
        {
            label: 'cc + cloudflare-ai',
            endpoint: '/chat/completions',
            model,
            engine: 'cloudflare-ai',
        },
        {
            label: `responses + native (${citeModel})`,
            endpoint: '/responses',
            model: citeModel,
            engine: 'native',
        },
        {
            label: `cc + native (${citeModel})`,
            endpoint: '/chat/completions',
            model: citeModel,
            engine: 'native',
        },
    ];
    for (const probe of probes) {
        const body =
            probe.endpoint === '/responses'
                ? orResponsesPdfBody(probe.model, pdfUrl, probe.engine)
                : orCCBody(probe.model, [orCCPdfMessage(pdfUrl)], probe.engine);
        const call = await orPost(apiKey, probe.endpoint, body);
        if (!call.ok) {
            orLogFailure(probe.label, call);
            continue;
        }
        const anns =
            probe.endpoint === '/responses'
                ? orResponsesAnnotations(call.json)
                : orCCAnnotations(call.json);
        const reply =
            probe.endpoint === '/responses'
                ? orResponsesText(call.json)
                : orCCText(call.json);
        console.log(
            `${probe.label}: (${call.ms}ms, ${orUsageSummary(call.json)}) correct=${/orange/i.test(reply)}` +
                ` annotations: ${orAnnotationSummary(anns)}`
        );
        if (dump && anns.length) console.log(JSON.stringify(anns, null, 2));
    }
    console.log(
        '-> looking for: a `file` annotation (replay payload for Phase B), and any',
        'citation-shaped annotations on the anthropic/* probes (document-citation passthrough).'
    );
}

async function testORReplay(
    apiKey: string,
    model: string,
    dump: boolean
): Promise<void> {
    console.log(
        '\n=== TEST replay (openrouter): does resending annotations skip re-parsing, and can they ALONE carry the doc? ==='
    );
    const pdfUrl = orPdfDataUrl();
    const engine: OREngine = 'cloudflare-ai';

    const t1 = await orPost(
        apiKey,
        '/chat/completions',
        orCCBody(model, [orCCPdfMessage(pdfUrl)], engine)
    );
    if (!t1.ok) {
        orLogFailure('turn1 (cc)', t1);
        return;
    }
    const t1Text = orCCText(t1.json);
    const t1Anns = orCCAnnotations(t1.json);
    console.log(
        `turn1 (cc, ${engine}): (${t1.ms}ms, ${orUsageSummary(t1.json)})` +
            ` reply=${JSON.stringify(t1Text.trim().slice(0, 80))}`
    );
    console.log('turn1 annotations:', orAnnotationSummary(t1Anns));
    if (dump && t1Anns.length) console.log(JSON.stringify(t1Anns, null, 2));
    if (!t1Anns.length) {
        console.log(
            '-> no annotations on turn 1; nothing to replay (re-check engine/model before concluding)'
        );
        return;
    }

    const userWithFile = orCCPdfMessage(pdfUrl);
    const userTextOnly = { role: 'user', content: OR_PDF_QUESTION };
    const followUp = { role: 'user', content: OR_PDF_FOLLOWUP };
    const assistantPlain = { role: 'assistant', content: t1Text };
    const assistantWithAnns = {
        role: 'assistant',
        content: t1Text,
        annotations: t1Anns,
    };

    const variants: Array<{ label: string; messages: unknown[] }> = [
        {
            label: 'a) file resent, no annotations (baseline re-parse)',
            messages: [userWithFile, assistantPlain, followUp],
        },
        {
            label: 'b) file resent + annotations (parse skip?)',
            messages: [userWithFile, assistantWithAnns, followUp],
        },
        {
            label: 'c) NO file, annotations only (carrier?)',
            messages: [userTextOnly, assistantWithAnns, followUp],
        },
        {
            label: 'd) NO file, no annotations (control for c)',
            messages: [userTextOnly, assistantPlain, followUp],
        },
    ];
    for (const v of variants) {
        const call = await orPost(
            apiKey,
            '/chat/completions',
            orCCBody(model, v.messages, engine)
        );
        if (!call.ok) {
            orLogFailure(v.label, call);
            continue;
        }
        const reply = orCCText(call.json);
        console.log(
            `${v.label}: (${call.ms}ms, ${orUsageSummary(call.json)})` +
                ` mentions color=${/orange/i.test(reply)}`
        );
        console.log('   reply:', JSON.stringify(reply.trim().slice(0, 200)));
    }
    console.log(
        '-> read it as: b faster/cheaper than a = replay skips re-parsing;',
        'c correct while d wrong/clueless = the annotation alone carries the parsed doc.'
    );

    const rt1 = await orPost(
        apiKey,
        '/responses',
        orResponsesPdfBody(model, pdfUrl, engine)
    );
    if (!rt1.ok) {
        orLogFailure('responses turn1', rt1);
        return;
    }
    const rAnns = orResponsesAnnotations(rt1.json);
    console.log('responses turn1 annotations:', orAnnotationSummary(rAnns));
    if (!rAnns.length) {
        console.log(
            '-> responses endpoint returned NO annotations: replay would require chat completions (or skip Phase B for the responses API)'
        );
        return;
    }
    const messageItems = orResponsesMessageItems(rt1.json);
    const replay = await orPost(apiKey, '/responses', {
        model,
        input: [
            {
                role: 'user',
                content: [
                    { type: 'input_text', text: OR_PDF_QUESTION },
                    {
                        type: 'input_file',
                        filename: 'test_pdf.pdf',
                        file_data: pdfUrl,
                    },
                ],
            },
            ...messageItems,
            {
                role: 'user',
                content: [{ type: 'input_text', text: OR_PDF_FOLLOWUP }],
            },
        ],
        max_output_tokens: 1024,
        stream: false,
        ...orPlugins(engine),
    });
    if (!replay.ok) {
        console.log(
            `responses replay (verbatim output message items as input): REJECTED HTTP ${replay.status}:`,
            replay.errorText
        );
        return;
    }
    if (dump) console.log(JSON.stringify(asObj(replay.json)?.output, null, 2));
    console.log(
        `responses replay: ACCEPTED (${replay.ms}ms, ${orUsageSummary(replay.json)})` +
            ` reply=${JSON.stringify(orResponsesText(replay.json).trim().slice(0, 200))}`
    );
}

async function runOpenRouter(
    apiKey: string,
    model: string,
    textModel: string,
    citeModel: string,
    dump: boolean,
    tests: OpenRouterTestName[]
): Promise<void> {
    console.log(`=== file-testing: openrouter / ${model} ===`);
    const runners: Record<OpenRouterTestName, () => Promise<void>> = {
        image: () => testORImage(apiKey, model, dump),
        pdf: () => testORPdf(apiKey, model, dump),
        fallback: () => testORFallback(apiKey, textModel, dump),
        annotations: () => testORAnnotations(apiKey, model, citeModel, dump),
        replay: () => testORReplay(apiKey, model, dump),
    };
    for (const t of tests) await runners[t]();
}

function printHelp(): void {
    console.log(`file-testing - discovery harness for code-exec FILE OUTPUTS

Usage:
  bun scripts/file-testing.ts --provider anthropic [options]
  bun scripts/file-testing.ts --provider openai [options]
  bun scripts/file-testing.ts --provider google [options]
  bun scripts/file-testing.ts --provider openrouter [options]

Options:
  --provider <name>   anthropic | openai | google | openrouter   (default: anthropic)
  --model <id>        override the provider's default model
  --test <names>      comma list (default: all)
                        anthropic:  ${ALL_TESTS.join(', ')}
                        openai:     ${OPENAI_TESTS.join(', ')} (default: shell; expire waits 21 min)
                        google:     ${GOOGLE_TESTS.join(', ')}
                        openrouter: ${OPENROUTER_TESTS.join(', ')}
  --text-model <id>   (openrouter) text-only model for the fallback test
                        (default: ${OPENROUTER_DEFAULT_TEXT_MODEL})
  --cite-model <id>   (openrouter) anthropic/* model for citation passthrough
                        (default: ${OPENROUTER_DEFAULT_CITE_MODEL})
  --dump              print the raw result/container JSON per turn
  -h, --help          show this help

Provider defaults (model / required env var):
  anthropic   claude-haiku-4-5        / ANTHROPIC_API_KEY
  openai      gpt-5.5                 / OPENAI_API_KEY
  google      gemini-3.5-flash        / GOOGLE_API_KEY
  openrouter  google/gemini-2.5-flash / OPENROUTER_API_KEY`);
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('-h') || args.includes('--help')) {
        printHelp();
        return;
    }
    const provider = (flag('--provider') ?? 'anthropic') as ProviderName;
    const defaults = PROVIDER_DEFAULTS[provider];
    if (!defaults) {
        console.error(
            `Unknown provider '${provider}'. Valid: anthropic, openai, google, openrouter.`
        );
        process.exit(1);
    }
    const model = flag('--model') ?? defaults.model;
    const apiKey = process.env[defaults.env];
    if (!apiKey) {
        console.error(`${defaults.env} missing from .env`);
        process.exit(1);
    }
    const dump = args.includes('--dump');
    const testArg = flag('--test');

    mkdirSync(OUT_DIR, { recursive: true });

    if (provider === 'openai') {
        const tests = testArg
            ? pickTests(testArg, OPENAI_TESTS)
            : (['shell'] as OpenAITestName[]);
        if (!tests.length) {
            console.error(
                `Unknown --test '${testArg}'. Valid: ${OPENAI_TESTS.join(', ')}, all`
            );
            process.exit(1);
        }
        await runOpenAI(apiKey, model, dump, tests);
        return;
    }
    if (provider === 'google') {
        const tests = pickTests(testArg, GOOGLE_TESTS);
        if (!tests.length) {
            console.error(
                `Unknown --test '${testArg}'. Valid: ${GOOGLE_TESTS.join(', ')}, all`
            );
            process.exit(1);
        }
        await runGoogle(apiKey, model, dump, tests);
        return;
    }
    if (provider === 'openrouter') {
        const tests = pickTests(testArg, OPENROUTER_TESTS);
        if (!tests.length) {
            console.error(
                `Unknown --test '${testArg}'. Valid: ${OPENROUTER_TESTS.join(', ')}, all`
            );
            process.exit(1);
        }
        await runOpenRouter(
            apiKey,
            model,
            flag('--text-model') ?? OPENROUTER_DEFAULT_TEXT_MODEL,
            flag('--cite-model') ?? OPENROUTER_DEFAULT_CITE_MODEL,
            dump,
            tests
        );
        return;
    }

    const toolType = codeExecWire(provider, model);
    if (!toolType) {
        console.error(`${model} has no code_execution server tool`);
        process.exit(1);
    }
    const tests = pickTests(testArg, ALL_TESTS);
    if (!tests.length) {
        console.error(
            `Unknown --test '${testArg}'. Valid: ${ALL_TESTS.join(', ')}, all`
        );
        process.exit(1);
    }

    const client = new Anthropic({ apiKey });
    console.log(
        `=== file-testing: ${provider} / ${model} - tool=${toolType} ===`
    );
    console.log(`output dir: ${OUT_DIR}`);

    const runners: Record<TestName, () => Promise<void>> = {
        stream: () => testStream(client, model, toolType, dump),
        create: () => testCreate(client, model, toolType, dump),
        persist: () => testPersist(client, model, toolType, dump),
        reuse: () => testReuse(client, model, toolType, dump),
        reref: () => testReref(client, model, toolType, dump),
        inline: () => testInline(client, model, toolType, dump),
        upload: () => testUpload(apiKey, model, dump),
        editpersist: () => testEditPersist(client, model, toolType, dump),
    };
    for (const t of tests) await runners[t]();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
