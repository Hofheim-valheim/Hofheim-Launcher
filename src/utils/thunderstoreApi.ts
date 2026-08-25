export type VersionInfo = {
  name: string
  full_name: string
  description: string
  icon: string
  version_number: string
  download_url: string
  downloads: number
  date_created: string
  website_url: string
  is_active: boolean
  file_size: number
  dependencies: string[]
}

export interface ThunderstoreMod {
  name: string
  full_name: string
  owner: string
  package_url: string
  date_created: string
  date_updated: string
  rating_score: number
  is_pinned: boolean
  is_deprecated: boolean
  total_downloads: number
  categories: string[]
  latest: VersionInfo
  /** All available version numbers, newest first. */
  versions: { version_number: string }[]
}

let cachedMods: ThunderstoreMod[] | null = null
let cacheTime: number = 0
const CACHE_DURATION = 5 * 60 * 1000

export async function fetchAllMods(): Promise<ThunderstoreMod[]> {
  const now = Date.now()
  if (cachedMods && now - cacheTime < CACHE_DURATION) {
    return cachedMods
  }

  let result: ThunderstoreMod[]

  // Use IPC when running inside Electron — main process normalizes to ~5MB before transfer
  const w = window as any
  if (w?.Hofheim?.thunderstore?.fetchAll) {
    result = await w.Hofheim.thunderstore.fetchAll()
  } else {
    // Browser fallback: fetch full dump and normalize client-side
    const res = await fetch('https://thunderstore.io/c/valheim/api/v1/package/')
    if (!res.ok) throw new Error(`Thunderstore HTTP ${res.status}`)
    const raw: any[] = await res.json()
    if (!Array.isArray(raw)) throw new Error('Resposta inesperada do Thunderstore')
    // Note: Thunderstore API no longer includes total_downloads at package level — sum from versions
    result = raw
      .filter(pkg => Array.isArray(pkg.versions) && pkg.versions.length > 0)
      .map(pkg => {
        const v = pkg.versions[0]
        const total_downloads = (pkg.versions as any[]).reduce((sum, ver) => sum + (ver.downloads || 0), 0)
        return {
          name: pkg.name,
          full_name: pkg.full_name,
          owner: pkg.owner,
          package_url: pkg.package_url,
          date_created: pkg.date_created,
          date_updated: pkg.date_updated,
          rating_score: pkg.rating_score,
          is_pinned: pkg.is_pinned,
          is_deprecated: pkg.is_deprecated,
          total_downloads,
          categories: pkg.categories,
          latest: {
            name: v.name,
            full_name: v.full_name,
            description: v.description,
            icon: v.icon,
            version_number: v.version_number,
            download_url: v.download_url,
            downloads: v.downloads,
            date_created: v.date_created,
            website_url: v.website_url,
            is_active: v.is_active,
            file_size: v.file_size,
            dependencies: v.dependencies || [],
          },
          versions: (pkg.versions as any[]).map((ver: any) => ({ version_number: ver.version_number })),
        } as ThunderstoreMod
      })
  }

  // Keep deprecated mods in the cache — ModpackEditorView filters them out by default
  // and offers a toggle to show them (they're still needed to fulfil old modpacks/dependencies).
  cachedMods = result
  cacheTime = now
  return cachedMods
}

export function clearModsCache() {
  cachedMods = null
  cacheTime = 0
}

export function getThunderstoreId(mod: ThunderstoreMod): string {
  return `${mod.owner}-${mod.name}`
}

export function getDownloadUrl(owner: string, name: string, version: string): string {
  return `https://thunderstore.io/package/download/${owner}/${name}/${version}/`
}
