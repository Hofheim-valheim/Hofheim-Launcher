import { Modpack, ModpackTarget, PrivateModDownload } from '../types'

export const DEFAULT_BACKEND_URL = 'https://hofheim-launcher-backend.hofheim-valheim.workers.dev'

/** URLs de backend antigas que saíram do ar — tratadas como vazias para cair no DEFAULT_BACKEND_URL. */
const LEGACY_BACKEND_URLS = [
  'https://glitnir-launcher-backend.glitnir.workers.dev',
  'https://glitnir-launcher-backend.glitnir-valhala.workers.dev',
]

/** Normaliza uma backendUrl salva: retorna '' se for uma URL legada (ou vazia), forçando o default. */
export function normalizeBackendUrl(backendUrl?: string): string {
  const trimmed = (backendUrl || '').replace(/\/+$/, '')
  if (!trimmed) return ''
  return LEGACY_BACKEND_URLS.some(u => u.replace(/\/+$/, '') === trimmed) ? '' : trimmed
}

function base(backendUrl?: string): string {
  return (backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, '')
}

/** Faz login no backend e retorna o token de sessão. */
export async function login(password: string, backendUrl?: string): Promise<string> {
  const res = await fetch(`${base(backendUrl)}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as any).error || 'Falha na autenticação')
  }
  const data = (await res.json()) as { token: string }
  return data.token
}

/**
 * Busca o modpack público de um mundo via backend (sem autenticação).
 * `target` escolhe o mundo: 'main' = Mundo 1, 'main2' = Mundo 2.
 */
export async function getPublicModpack(
  backendUrl?: string,
  bustCache = false,
  target: Exclude<ModpackTarget, 'admin'> = 'main',
): Promise<Modpack> {
  // Sem cache-bust/no-store de propósito: o Worker serve com ETag e cacheia na borda (KV).
  // Assim o cache HTTP do Electron revalida sozinho com If-None-Match → 304 quando nada mudou,
  // e o polling não fura a borda nem executa o Worker à toa.
  //
  // `bustCache` é a exceção: o "reinstalar do zero" precisa da verdade do backend AGORA, sem
  // depender de cache local nem de borda. Só é usado nesse clique manual, não no polling.
  const res = await fetch(
    `${base(backendUrl)}/modpacks/${target}${bustCache ? `?t=${Date.now()}` : ''}`,
    bustCache ? { cache: 'no-store' } : undefined,
  )
  if (!res.ok) throw new Error('Falha ao buscar modpack público')
  return res.json()
}

/** Busca o modpack secreto de admin (requer token válido). */
export async function getAdminModpack(token: string, backendUrl?: string, bustCache = false): Promise<Modpack> {
  // Sem cache-bust/no-store: revalidação via ETag (If-None-Match → 304) como no getPublicModpack.
  // `bustCache` idem: só no "reinstalar do zero", que precisa do estado atual do backend.
  const res = await fetch(`${base(backendUrl)}/modpacks/admin${bustCache ? `?t=${Date.now()}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
    ...(bustCache ? { cache: 'no-store' as RequestCache } : {}),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as any).error || 'Falha ao buscar modpack admin')
  }
  return res.json()
}

/** Publica (commita) um modpack no GitHub via backend. */
export async function publishModpack(
  token: string,
  target: ModpackTarget,
  modpack: Modpack,
  message?: string,
  backendUrl?: string,
): Promise<void> {
  const res = await fetch(`${base(backendUrl)}/modpacks/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ target, modpack, message }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as any).error || 'Falha ao publicar modpack')
  }
}

/**
 * Lista os mods privados disponíveis no repo.
 *
 * Endpoint esperado no Worker:
 *   GET /mods/private
 *   Authorization: Bearer <token>
 *   → 200 { mods: { filename: string, size: number, updatedAt: string }[] }
 */
export async function listPrivateMods(
  token: string,
  backendUrl?: string,
): Promise<{ filename: string; size: number; updatedAt: string }[]> {
  const res = await fetch(`${base(backendUrl)}/mods/private`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as any).error || 'Falha ao listar mods privados')
  }
  const data = await res.json() as { mods: { filename: string; size: number; updatedAt: string }[] }
  return data.mods || []
}

/**
 * Faz upload de um arquivo de mod privado para o backend.
 * O backend commita o arquivo no repo privado de mods.
 *
 * Endpoint esperado no Worker:
 *   POST /mods/private/upload
 *   Authorization: Bearer <token>
 *   Content-Type: application/json
 *   Body: { filename: string, content: string (base64) }
 *   → 200 { success: true }
 */
export async function uploadPrivateMod(
  token: string,
  filename: string,
  contentBase64: string,
  backendUrl?: string,
): Promise<void> {
  const res = await fetch(`${base(backendUrl)}/mods/private/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ filename, content: contentBase64 }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as any).error || 'Falha ao fazer upload do mod')
  }
}

/**
 * Faz upload de uma imagem (base64) para o backend, que commita em images/<filename> no repo.
 * Endpoint: POST /images/upload  →  { url: string } (URL raw do arquivo no GitHub)
 */
export async function uploadImage(
  token: string,
  filename: string,
  contentBase64: string,
  backendUrl?: string,
): Promise<{ url: string }> {
  const res = await fetch(`${base(backendUrl)}/images/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ filename, content: contentBase64 }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as any).error || 'Falha ao fazer upload da imagem')
  }
  return res.json() as Promise<{ url: string }>
}

/**
 * Faz upload de um config para o R2 via backend e retorna a URL pública
 * content-addressed. Usado para configs que não podem (ou não devem) virar string JSON
 * no modpack: binários como spritesheet .png, e textos grandes que estourariam o
 * orçamento do modpack.json. O modpack guarda a URL no `content` e o player baixa os
 * bytes via `mods:applyConfig`.
 *
 * Endpoint: PUT /configs/upload?filename=..&sha256=..  (corpo = bytes crus) -> { url, key }
 *
 * Manda os BYTES, não base64: o POST antigo embrulhava o arquivo num JSON e o Worker
 * segurava várias cópias dele na memória — com muitas configs em paralelo isso estourava
 * o limite de 128MB do isolate. O `sha256` (dos bytes) vai na query porque o Worker
 * precisa dele antes do corpo: forma a key content-addressed E é validado pelo próprio
 * R2, que recusa a gravação se os bytes recebidos não baterem.
 *
 * Para config que já está em ARQUIVO no disco, prefira `window.Hofheim.configs
 * .uploadFileStream`: lá os bytes vão direto do disco pro socket, sem passar pelo
 * renderer. Esta função é para conteúdo que já está em memória.
 */
export async function uploadConfig(
  token: string,
  filename: string,
  // Uint8Array<ArrayBuffer> (e não Uint8Array): o TS 5.7+ distingue buffer normal de
  // SharedArrayBuffer, e só o primeiro serve como corpo de fetch / entrada do digest.
  bytes: Uint8Array<ArrayBuffer>,
  backendUrl?: string,
): Promise<{ url: string; key: string }> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const sha256 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  const q = `filename=${encodeURIComponent(filename)}&sha256=${sha256}`
  const res = await fetch(`${base(backendUrl)}/configs/upload?${q}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      Authorization: `Bearer ${token}`,
    },
    // Body de tipo BufferSource: o fetch define Content-Length sozinho. Não trocar por
    // ReadableStream — aí iria chunked, e o R2 recusa stream sem tamanho conhecido.
    body: bytes,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as any).error || 'Falha ao enviar config')
  }
  return res.json() as Promise<{ url: string; key: string }>
}

/** Busca as notícias/home data do backend (sem autenticação). */
export async function getNews(backendUrl?: string): Promise<any> {
  // Sem cache-bust/no-store: o Worker serve com ETag e o publishNews() atualiza o KV/purga a
  // borda, então o cache HTTP do Electron revalida sozinho (If-None-Match → 304) sem servir stale.
  const res = await fetch(`${base(backendUrl)}/news`)
  if (!res.ok) throw new Error('Falha ao buscar notícias')
  return res.json()
}

/** Publica as notícias/home data no backend (requer token válido). */
export async function publishNews(token: string, news: object, backendUrl?: string): Promise<void> {
  const res = await fetch(`${base(backendUrl)}/news`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(news),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as any).error || 'Falha ao publicar notícias')
  }
}

/**
 * Resolve a URL/headers de download de um mod privado.
 * O `downloadUrl` do manifesto é um caminho relativo (ex: /mods/private/Foo.zip)
 * que será resolvido contra o backend. O backend serve estes mods sem exigir
 * login (o modpack público pode referenciá-los), então o token é opcional; só
 * é enviado quando um admin está logado.
 */
export function resolvePrivateMod(
  downloadUrl: string,
  token?: string | null,
  backendUrl?: string,
): PrivateModDownload {
  const path = downloadUrl.startsWith('/') ? downloadUrl : `/${downloadUrl}`
  return {
    url: `${base(backendUrl)}${path}`,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  }
}
