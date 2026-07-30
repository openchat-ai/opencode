import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const MAX_PASTED_FILEPATHS = 32

export type LocalFiles = Readonly<{
  readText(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
  mime(path: string): Promise<string>
}>

export type LocalAttachment =
  | Readonly<{ type: "text"; mime: "image/svg+xml"; content: string }>
  | Readonly<{ type: "binary"; mime: string; content: Uint8Array }>

export function readLocalAttachment(file: string) {
  return readLocalAttachmentWith(
    {
      readText: (value) => readFile(value, "utf8"),
      readBytes: (value) => readFile(value),
      mime: async (value) => mimeTypes[path.extname(value).toLowerCase()] ?? "application/octet-stream",
    },
    file,
  )
}

const mimeTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
}

export function normalizePastedFilepath(value: string, platform: string) {
  const raw = value.replace(/^['"]+|['"]+$/g, "")
  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw)
    } catch {}
  }
  if (platform === "win32") return raw
  return raw.replace(/\\(.)/g, "$1")
}

export function parsePastedFilepaths(value: string, platform: string) {
  const result: string[] = []
  let current = ""
  let quote = ""

  function push() {
    if (!current) return
    result.push(normalizePastedFilepath(current, platform))
    current = ""
  }

  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (quote) {
      if (character === quote) {
        quote = ""
        continue
      }
      if (character === "\\" && platform !== "win32" && quote === '"' && index + 1 < value.length) {
        current += value[++index]
        continue
      }
      current += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === "\\" && platform !== "win32" && index + 1 < value.length) {
      current += value[++index]
      continue
    }
    if (/\s/.test(character)) {
      push()
      if (result.length > MAX_PASTED_FILEPATHS) return []
      continue
    }
    current += character
  }

  if (quote) return []
  push()
  if (result.length > MAX_PASTED_FILEPATHS) return []
  return result
}

export function isSupportedLocalAttachmentPath(file: string) {
  return path.extname(file).toLowerCase() in mimeTypes
}

export async function readLocalAttachmentWith(files: LocalFiles, path: string): Promise<LocalAttachment | undefined> {
  const mime = await files.mime(path).catch(() => undefined)
  if (!mime) return
  if (mime === "image/svg+xml") {
    const content = await files.readText(path).catch(() => undefined)
    if (!content) return
    return { type: "text", mime, content }
  }
  if (!mime.startsWith("image/") && mime !== "application/pdf") return
  const content = await files.readBytes(path).catch(() => undefined)
  if (!content) return
  return { type: "binary", mime, content }
}
