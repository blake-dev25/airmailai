import type { DraftAttachmentMeta, ProviderId } from '@airmailai/shared';
import { appLifecycle } from './appLifecycle.svelte';
import { appMode } from './appMode.svelte';
import { chatStore } from './chatStore.svelte';
import { reportAppError } from './errorStore.svelte';
import {
    type FilePolicyOptions,
    formatFileSize,
    getAcceptForProvider,
    getFilePolicy,
    resolveFileMediaType,
    validateFilename,
    validateReadyAttachments,
} from './files';
import type { ModelOption } from './models';
import { providersStore } from './providersStore.svelte';
import { settingsStore } from './settingsStore.svelte';

const MAX_VISIBLE_FILE_ERRORS = 3;

interface ProcessingAttachment {
    id: string;
    chatId: string;
    name: string;
    progress: number;
}

interface FileError {
    id: string;
    message: string;
}

export type AttachmentUploads = ReturnType<typeof createAttachmentUploads>;

export function createAttachmentUploads() {
    let processing = $state<ProcessingAttachment[]>([]);
    let fileErrors = $state<FileError[]>([]);
    let processingQueue = Promise.resolve();

    const pending = $derived(chatStore.activeDraftAttachments);
    const activeProcessing = $derived(
        processing.filter((a) => a.chatId === chatStore.activeChatId)
    );
    const policyOptions = $derived({
        openRouterPdfEngine: settingsStore.openRouterPdfEngine,
        customModel: !!settingsStore.customModel,
        providerFileStorage: settingsStore.enableProviderFileStorage,
    });
    const policy = $derived(
        getFilePolicy(
            settingsStore.providerId,
            providersStore.selectedModel,
            policyOptions
        )
    );
    const accept = $derived(
        getAcceptForProvider(
            settingsStore.providerId,
            providersStore.selectedModel,
            policyOptions
        )
    );
    const canAttach = $derived(policy.mimeTypes.size > 0);
    const totalBytes = $derived(
        pending.reduce((total, attachment) => total + attachment.sizeBytes, 0)
    );
    const canAcceptDrops = $derived(
        settingsStore.enableFileUploads &&
            !appMode.isDemo &&
            canAttach &&
            !chatStore.isActiveChatBusy
    );

    function addFileError(message: string) {
        fileErrors = [
            { id: crypto.randomUUID(), message: `File Error: ${message}` },
            ...fileErrors,
        ].slice(0, MAX_VISIBLE_FILE_ERRORS);
    }

    function setProcessingProgress(id: string, progress: number) {
        processing = processing.map((attachment) =>
            attachment.id === id ? { ...attachment, progress } : attachment
        );
    }

    function removeProcessing(id: string) {
        processing = processing.filter((attachment) => attachment.id !== id);
    }

    async function processFile(
        file: File,
        id: string,
        uploadProviderId: ProviderId,
        uploadModel: ModelOption | null,
        uploadOpts: FilePolicyOptions,
        chatId: string,
        replicateTo: ProviderId | undefined
    ) {
        const uploadPolicy = getFilePolicy(
            uploadProviderId,
            uploadModel,
            uploadOpts
        );

        try {
            setProcessingProgress(id, 12);
            const nameCheck = validateFilename(file.name);
            if (!nameCheck.ok) {
                addFileError(nameCheck.message);
                removeProcessing(id);
                return;
            }

            const mediaType = resolveFileMediaType(
                file,
                uploadProviderId,
                uploadModel,
                uploadOpts
            );
            if (!mediaType) {
                addFileError(`${file.name} is not supported by this provider.`);
                removeProcessing(id);
                return;
            }

            setProcessingProgress(id, 38);
            if (file.size > uploadPolicy.maxFileBytes) {
                addFileError(
                    `${file.name} is ${formatFileSize(file.size)}. Limit: ${formatFileSize(uploadPolicy.maxFileBytes)}.`
                );
                removeProcessing(id);
                return;
            }

            setProcessingProgress(id, 48);
            const draftAtt: DraftAttachmentMeta = {
                name: file.name,
                mediaType,
                sizeBytes: file.size,
            };
            const nextAttachments = [
                ...(chatStore.chats.find((c) => c.id === chatId)
                    ?.draftAttachments ?? []),
                draftAtt,
            ];
            const validation = validateReadyAttachments(
                nextAttachments,
                uploadProviderId,
                uploadModel,
                uploadOpts
            );
            if (!validation.ok) {
                addFileError(validation.message);
                removeProcessing(id);
                return;
            }

            await chatStore.addDraftAttachment(
                chatId,
                replicateTo,
                draftAtt,
                file,
                (progress) => setProcessingProgress(id, 50 + progress * 50)
            );
            removeProcessing(id);
        } catch (error) {
            addFileError(
                error instanceof Error
                    ? `${file.name}: ${error.message}`
                    : `${file.name} could not be processed.`
            );
            removeProcessing(id);
        }
    }

    async function addFiles(files: File[]) {
        if (!files.length) return;
        await appLifecycle.ready;

        fileErrors = [];
        const uploadProviderId = settingsStore.providerId;
        const uploadModel = providersStore.selectedModel;
        const uploadOpts = policyOptions;
        const replicateTo = settingsStore.enableProviderFileStorage
            ? uploadProviderId
            : undefined;
        let chatId: string;
        try {
            chatId = await chatStore.prepareAttachmentUpload();
        } catch (error) {
            reportAppError(
                'prepare attachment upload failed',
                "Couldn't attach files",
                error
            );
            return;
        }
        const uploadPolicy = getFilePolicy(
            uploadProviderId,
            uploadModel,
            uploadOpts
        );
        const slots = Math.max(
            0,
            uploadPolicy.maxAttachments -
                (chatStore.chats.find((c) => c.id === chatId)?.draftAttachments
                    ?.length ?? 0) -
                processing.filter((a) => a.chatId === chatId).length
        );
        const toAdd = files.slice(0, slots);

        if (toAdd.length < files.length) {
            addFileError(
                `Only ${uploadPolicy.maxAttachments} files can be attached for this provider.`
            );
        }

        const queued = toAdd.map((file) => ({
            file,
            id: crypto.randomUUID(),
        }));
        processing = [
            ...processing,
            ...queued.map(({ file, id }) => ({
                id,
                chatId,
                name: file.name,
                progress: 0,
            })),
        ];
        processingQueue = processingQueue.then(async () => {
            for (const { file, id } of queued) {
                await processFile(
                    file,
                    id,
                    uploadProviderId,
                    uploadModel,
                    uploadOpts,
                    chatId,
                    replicateTo
                );
            }
        });
    }

    return {
        get pending() {
            return pending;
        },
        get activeProcessing() {
            return activeProcessing;
        },
        get fileErrors() {
            return fileErrors;
        },
        get policy() {
            return policy;
        },
        get accept() {
            return accept;
        },
        get canAttach() {
            return canAttach;
        },
        get totalBytes() {
            return totalBytes;
        },
        get canAcceptDrops() {
            return canAcceptDrops;
        },
        addFiles,
        dismissFileError(id: string) {
            fileErrors = fileErrors.filter((error) => error.id !== id);
        },
        removeDraft(hash: string) {
            chatStore.removeDraftAttachment(hash).catch((err) => {
                reportAppError(
                    'remove draft attachment failed',
                    "Couldn't remove the attachment",
                    err
                );
            });
        },
        validateForSend(): boolean {
            const validation = validateReadyAttachments(
                pending,
                settingsStore.providerId,
                providersStore.selectedModel,
                policyOptions
            );
            if (validation.ok) return true;
            addFileError(validation.message);
            return false;
        },
    };
}
