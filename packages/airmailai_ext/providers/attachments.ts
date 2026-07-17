import type { AirmailAIMessage, ProviderFileEntry } from '@airmailai/shared';

export type ResolvedAttachment =
    | {
          kind: 'blob';
          hash: string;
          filename: string;
          mediaType: string;
          base64: string;
      }
    | {
          kind: 'provider';
          providerId: string;
          fileId: string;
          uri?: string;
          hash: string;
          filename: string;
          mediaType: string;
          base64?: string;
      };

export interface ProviderReplicas {
    providerId: string;
    files: Record<string, ProviderFileEntry>;
}

export function resolveAttachments(
    msg: AirmailAIMessage,
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
                hash,
                filename,
                mediaType: mediaType || entry?.mediaType || '',
                ...(entry ? { base64: entry.base64 } : {}),
            });
            continue;
        }
        if (!entry) continue;
        resolved.push({
            kind: 'blob',
            hash,
            filename,
            mediaType: entry.mediaType,
            base64: entry.base64,
        });
    }
    return resolved;
}
