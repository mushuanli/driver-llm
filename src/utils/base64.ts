export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
}
export async function blobToBase64(blob: Blob): Promise<string> {
    return arrayBufferToBase64(await blob.arrayBuffer());
}
