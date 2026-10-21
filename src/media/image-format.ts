export function assertImageFormat(bytes: Uint8Array, format: string): void {
    const png = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
    const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    if (!(format === 'png' ? png : format === 'jpeg' ? jpeg : format === 'webp' && webp)) throw Object.assign(new Error('Generated image bytes do not match the requested format'), { code: 'MEDIA_IMAGE_FORMAT' });
}
