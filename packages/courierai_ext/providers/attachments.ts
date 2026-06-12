import type { CourierAIMessage, ProviderFileEntry } from '@courierai/shared';

export type ResolvedAttachment =
    | { kind: 'blob'; filename: string; mediaType: string; base64: string }
    | {
          kind: 'provider';
          providerId: string;
          fileId: string;
          uri?: string;
          filename: string;
          mediaType: string;
          base64?: string;
      };

export interface ProviderReplicas {
    providerId: string;
    files: Record<string, ProviderFileEntry>;
}

export function resolveAttachments(
    msg: CourierAIMessage,
    blobs: Record<string, { mediaType: string; base64: string }>,
    replicas?: ProviderReplicas
): ResolvedAttachment[] {
    const resolved: ResolvedAttachment[] = [];
    for (const part of msg.parts) {
        if (part.type !== 'file') continue;
        const { hash, filename, mediaType } = part;
        const entry = blobs[hash];
        const replica = replicas?.files[hash];
        if (replica) {
            resolved.push({
                kind: 'provider',
                providerId: replicas!.providerId,
                fileId: replica.fileId,
                ...(replica.uri ? { uri: replica.uri } : {}),
                filename,
                mediaType: mediaType || entry?.mediaType || '',
                ...(entry ? { base64: entry.base64 } : {}),
            });
            continue;
        }
        if (!entry) continue;
        resolved.push({
            kind: 'blob',
            filename,
            mediaType: entry.mediaType,
            base64: entry.base64,
        });
    }
    return resolved;
}
