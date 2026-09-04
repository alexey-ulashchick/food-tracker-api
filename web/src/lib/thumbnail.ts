/**
 * Downscales a picked photo for persistence.
 *
 * The full-size file still goes to Anthropic, but it is never stored — so this
 * thumbnail is the only thing chat history can replay. WebP at 320px lands
 * around 8–15 KB, comfortably inside the 40 KB the server accepts.
 */

const MAX_EDGE = 320
const QUALITY = 0.7

export async function makeThumb(file: File): Promise<string> {
  const bitmap = await loadBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas is unavailable')
  ctx.drawImage(bitmap, 0, 0, w, h)
  if ('close' in bitmap) bitmap.close()

  // Safari gained WebP encoding in 14; JPEG is the fallback and the server
  // accepts both.
  const webp = canvas.toDataURL('image/webp', QUALITY)
  if (webp.startsWith('data:image/webp')) return webp
  return canvas.toDataURL('image/jpeg', QUALITY)
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      // Fall through to the <img> path below.
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}
