import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Config, Mod, ModConfig, Modpack, ModpackTarget } from '../types'
import { fetchAllMods, clearModsCache, ThunderstoreMod, getDownloadUrl } from '../utils/thunderstoreApi'
import { fetchModpackFromUrl, buildModpackRawUrl, isBinaryConfigPath, isTextConfigPath, byteLength, stripModToReference } from '../utils/modManager'
import { getAdminModpack, getPublicModpack, publishModpack, listPrivateMods, uploadConfig, normalizeBackendUrl, DEFAULT_BACKEND_URL } from '../utils/backendApi'
import ErrorBoundary from '../components/ErrorBoundary'
import './AdminView.css'

interface Props {
  config: Config
  adminToken: string | null
  onSave?: (updates: Partial<Config>) => Promise<void>
}

/**
 * Cada mundo do servidor é um modpack independente publicado num alvo próprio:
 * `main` = Mundo 1, `main2` = Mundo 2, `admin` = modpack secreto de teste.
 */
type Target = ModpackTarget
type Tab = 'online' | 'modpack' | 'configs'

/** Nome de cada alvo na interface do admin. */
const TARGET_LABELS: Record<Target, string> = {
  main: 'Hofheim Mundo 1',
  main2: 'Hofheim Mundo 2',
  admin: 'Hofheim Admin',
}

type PackDraft = {
  name: string
  description: string
  version: string
  battlemetricsId: string
  mods: Mod[]
  configs: ModConfig[]
}

const PAGE_SIZE = 50

/** Prefixo de installPath de tudo que vive na pasta de configs do perfil. */
const CONFIG_PREFIX = 'BepInEx/config/'

/**
 * Plano de espelhamento: o que muda no modpack para ele ficar IGUAL à pasta local do admin.
 * O installPath de cada entrada vem da posição do arquivo DENTRO da pasta escolhida, então
 * `Icons/x.png` no disco vira `BepInEx/config/Icons/x.png` no player — é isso que garante que
 * a estrutura de pastas seja replicada em vez de tudo cair solto na raiz de config/.
 */
type MirrorPlan = {
  /** Não está no modpack ainda. */
  toAdd: { rel: string; binary: boolean; sha256?: string }[]
  /** Já está, mas o conteúdo do disco é outro (texto diferente ou hash de binário diferente). */
  toUpdate: { rel: string; binary: boolean; sha256?: string }[]
  /** Já está e é idêntico — nem lê nem reenvia. */
  unchanged: number
  /** Está no modpack sob BepInEx/config/ mas NÃO existe mais na pasta local. */
  toRemove: string[]
  /** Ficaram de fora: .zip (usar o card de pacote), vazios, extensão não reconhecida. */
  skippedZip: string[]
  skippedEmpty: string[]
  skippedUnknownExt: string[]
  /** Entradas preservadas sem análise: pacotes .zip extraíveis e configs fora de BepInEx/config/. */
  keptExtract: number
  keptOutside: number
}

export default function ModpackEditorView({ config, adminToken, onSave }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('online')
  const [target, setTarget] = useState<Target>('main')

  const [packName, setPackName] = useState('')
  const [packDescription, setPackDescription] = useState('')
  const [packVersion, setPackVersion] = useState('1.0.0')
  const [packBattlemetricsId, setPackBattlemetricsId] = useState('')
  const [modpackMods, setModpackMods] = useState<Mod[]>([])
  const [modpackConfigs, setModpackConfigs] = useState<ModConfig[]>([])
  // Busca na lista de mods JÁ no modpack (aba Modpack). Filtra só a exibição —
  // os handlers continuam usando o índice original do array (ver visibleModpackMods).
  const [modpackFilter, setModpackFilter] = useState('')

  // Selected version per mod in the Thunderstore browser (key: full_name), defaults to latest
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({})

  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState<'downloads' | 'rating' | 'updated' | 'name'>('downloads')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [showDeprecated, setShowDeprecated] = useState(false)
  const [allMods, setAllMods] = useState<ThunderstoreMod[]>([])
  const [loadingMods, setLoadingMods] = useState(false)
  const [modsError, setModsError] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const [privName, setPrivName] = useState('')
  const [privFilename, setPrivFilename] = useState('')
  // Private mod upload / repo list
  type PrivateModEntry = { filename: string; size: number; updatedAt: string }
  const [repoMods, setRepoMods] = useState<PrivateModEntry[]>([])
  const [repoLoading, setRepoLoading] = useState(false)
  const [repoError, setRepoError] = useState('')
  const [pendingFile, setPendingFile] = useState<{ token: string; filename: string; size: number } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadError, setUploadError] = useState('')

  const [cfgMod, setCfgMod] = useState('')
  const [cfgFilename, setCfgFilename] = useState('')
  const [cfgInstallPath, setCfgInstallPath] = useState('')
  const [cfgContent, setCfgContent] = useState('')
  // Discovered config files from the selected mod's zip
  const configScanCache = useRef<Record<string, { filename: string; installPath: string; content: string }[]>>({})
  const [cfgScanLoading, setCfgScanLoading] = useState(false)
  const [cfgDiscoveredFiles, setCfgDiscoveredFiles] = useState<{ filename: string; installPath: string; content: string }[]>([])

  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [publishing, setPublishing] = useState(false)
  // "Copiar do Mundo 1": confirmação + carregando (a busca no backend leva alguns segundos).
  const [confirmCopy, setConfirmCopy] = useState(false)
  const [copyingWorld1, setCopyingWorld1] = useState(false)
  // installPaths dos configs binários inline que o publish NÃO conseguiu subir pro R2
  // (arquivo não achado no disco). Quando setado, o banner de erro oferece removê-los.
  const [unresolvedBinaries, setUnresolvedBinaries] = useState<string[]>([])
  // Progresso REAL do publish: total = uploads planejados (binário + texto) + 1 (publish final).
  const [publishProgress, setPublishProgress] = useState<{ done: number; total: number; label: string } | null>(null)

  // ── Import / Export state ────────────────────────────────────────────────
  const [showImportExport, setShowImportExport] = useState(false)
  const [exportCode, setExportCode] = useState('')
  const [importCodeInput, setImportCodeInput] = useState('')
  const [importError, setImportError] = useState('')
  const [importSuccess, setImportSuccess] = useState('')
  // Qual import está rodando ('' = nenhum). Dá feedback visual e trava os botões durante o
  // trabalho (resolver código no Thunderstore / subir binários ao R2 pode levar segundos).
  const [importing, setImporting] = useState<'' | 'code' | 'file' | 'r2'>('')
  const [codeCopied, setCodeCopied] = useState(false)
  // ─────────────────────────────────────────────────────────────────────────

  // Config suggestions discovered from mod zip scans
  type ConfigSuggestion = { modName: string; configs: { filename: string; installPath: string; content: string }[] }
  const [suggestedConfigs, setSuggestedConfigs] = useState<ConfigSuggestion[]>([])
  const [scanningMods, setScanningMods] = useState<Set<string>>(new Set())

  // Inline editing of existing configs in the Configs tab
  const [editingConfigIndex, setEditingConfigIndex] = useState<number | null>(null)
  const [editingContent, setEditingContent] = useState('')

  // Local filesystem config reader
  const [localConfigDir, setLocalConfigDir] = useState('')
  const [localConfigFiles, setLocalConfigFiles] = useState<string[]>([])
  const [localConfigLoading, setLocalConfigLoading] = useState(false)
  const [localConfigError, setLocalConfigError] = useState('')
  const [localSelectedFile, setLocalSelectedFile] = useState('')
  const [localFileContent, setLocalFileContent] = useState('')
  const [localFileLoading, setLocalFileLoading] = useState(false)
  const [localFileSaving, setLocalFileSaving] = useState(false)
  const [localFileSaved, setLocalFileSaved] = useState(false)
  const [localUploading, setLocalUploading] = useState(false)
  const [localUploadError, setLocalUploadError] = useState('')
  // "Adicionar tudo": percorre a lista inteira de configs locais de uma vez.
  const [localAddAllRunning, setLocalAddAllRunning] = useState(false)
  const [localAddAllProgress, setLocalAddAllProgress] = useState({ done: 0, total: 0 })
  const [localAddAllResult, setLocalAddAllResult] = useState('')

  /** Realce da área de drop enquanto a pasta está sendo arrastada por cima. */
  const [localDirDragOver, setLocalDirDragOver] = useState(false)
  // Arquivos da pasta cuja extensão não é reconhecida como config (vêm do fs.listDir).
  // Não entram no modpack, mas contam como "existe no disco" no espelhamento.
  const [localUnknownFiles, setLocalUnknownFiles] = useState<string[]>([])
  /**
   * Espelhamento da pasta local no modpack. Fluxo em DUAS etapas de propósito: o plano é
   * calculado e mostrado (inclusive o que vai ser REMOVIDO) e só executa no segundo clique —
   * espelhar apaga entradas, e apagar 171 configs por engano vira estrago em 100+ jogadores.
   */
  const [mirrorPlan, setMirrorPlan] = useState<MirrorPlan | null>(null)
  const [mirrorRunning, setMirrorRunning] = useState(false)
  const [mirrorProgress, setMirrorProgress] = useState({ done: 0, total: 0 })
  const [mirrorResult, setMirrorResult] = useState('')
  const [mirrorError, setMirrorError] = useState('')

  // Pacote de configs em .zip (ex.: texturas): sobe em partes pelo main process e entra no
  // modpack como um config com `extract: true` — o player baixa e o launcher extrai no perfil.
  const [zipPick, setZipPick] = useState<{ token: string; filename: string; size: number; entries: number } | null>(null)
  const [zipDest, setZipDest] = useState('BepInEx/config')
  const [zipUploading, setZipUploading] = useState(false)
  const [zipProgress, setZipProgress] = useState(0)
  const [zipError, setZipError] = useState('')


  // Per-target drafts — persists unsaved changes when switching between modpacks
  const drafts = useRef<Partial<Record<Target, PackDraft>>>({})
  // Tracks which targets have had their data fetched at least once.
  // The draft-sync effect must not write until after the first fetch, otherwise
  // stale state gets saved as the new target's draft before the server responds.
  const loadedTargets = useRef<Set<Target>>(new Set())

  // Atalho pro fim da página: com muitos mods/configs o botão Publicar fica longe.
  // O scroll real acontece no <main className="layout-main"> do Layout, não aqui.
  const rootRef = useRef<HTMLDivElement>(null)
  const [showScrollDown, setShowScrollDown] = useState(false)

  const getScroller = useCallback(
    () => (rootRef.current?.closest('.layout-main') as HTMLElement | null) ?? null,
    [],
  )

  useEffect(() => {
    const scroller = getScroller()
    const content = rootRef.current
    if (!scroller || !content) return
    const update = () => {
      const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      setShowScrollDown(remaining > 300)
    }
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    // A página cresce/encolhe conforme mods e configs entram na lista — sem o observer
    // o botão só apareceria depois do primeiro scroll.
    const ro = new ResizeObserver(update)
    ro.observe(content)
    ro.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [getScroller])

  function scrollToBottom() {
    const scroller = getScroller()
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
  }

  // Pre-fill localConfigDir from saved config on mount
  useEffect(() => {
    if (config.adminProfilePath && !localConfigDir) {
      setLocalConfigDir(config.adminProfilePath)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const backendUrl = config.backendUrl || ''
  /**
   * URL do backend JÁ RESOLVIDA, para toda chamada que streama pelo main process
   * (mods:uploadPrivateModStream, configs:uploadZipStream, configs:uploadFileStream).
   *
   * O main não conhece o DEFAULT_BACKEND_URL — esse fallback é só do cliente, aplicado
   * dentro de `base()` no backendApi.ts — então URL vazia chega lá e volta como
   * "Backend inválido". Passa por normalizeBackendUrl também: uma URL legada salva no
   * config passaria o regex do main e só morreria depois, num worker fora do ar.
   */
  const streamBackendUrl = normalizeBackendUrl(backendUrl) || DEFAULT_BACKEND_URL
  const modpackRepo = config.modpackRepo || ''
  const modpackBranch = config.modpackBranch || 'main'

  const applyDraft = useCallback((draft: PackDraft) => {
    setPackName(draft.name)
    setPackDescription(draft.description)
    setPackVersion(draft.version)
    setPackBattlemetricsId(draft.battlemetricsId)
    setModpackMods(draft.mods)
    setModpackConfigs(draft.configs)
  }, [])

  const loadModpack = useCallback(async () => {
    setError('')
    // Restore in-memory draft first — no server round-trip needed.
    // Only use the draft after the target has been loaded at least once;
    // this prevents stale state written by the draft-sync effect (which runs
    // when target changes) from blocking the actual server fetch.
    const draft = drafts.current[target]
    if (draft && loadedTargets.current.has(target)) {
      applyDraft(draft)
      return
    }
    // First time loading this target — fetch from server
    try {
      let data: Modpack | null = null
      if (target === 'admin') {
        if (!adminToken) return
        data = await getAdminModpack(adminToken, backendUrl || undefined)
      } else {
        // Try backend first (uses DEFAULT_BACKEND_URL when backendUrl is empty); fall back to GitHub.
        // Cada mundo tem seu próprio arquivo/rota — daí o `target` nas duas buscas.
        try {
          data = await getPublicModpack(backendUrl || undefined, false, target)
        } catch { /* ignore */ }
        if (!data) {
          const url = buildModpackRawUrl(modpackRepo, modpackBranch, target)
          data = await fetchModpackFromUrl(url)
        }
      }
      const fetched: PackDraft = {
        name: data?.name || TARGET_LABELS[target],
        description: data?.description || '',
        version: data?.version || '1.0.0',
        battlemetricsId: data?.battlemetricsId || '',
        mods: data?.mods || [],
        configs: data?.configs || [],
      }
      loadedTargets.current.add(target)
      drafts.current[target] = fetched
      applyDraft(fetched)
    } catch {
      // Sem modpack publicado ainda (ex.: Mundo 2 recém-criado): começa vazio, com o nome
      // do alvo já preenchido. O admin monta a lista ou usa "Copiar do Mundo 1".
      loadedTargets.current.add(target)
      const fallback: PackDraft = {
        name: TARGET_LABELS[target],
        description: '',
        version: '1.0.0',
        battlemetricsId: '',
        mods: [],
        configs: [],
      }
      applyDraft(fallback)
    }
  }, [target, adminToken, backendUrl, modpackRepo, modpackBranch, applyDraft])

  useEffect(() => { loadModpack() }, [loadModpack])

  // Keep in-memory draft in sync with every edit so switching never loses work.
  // Guard: don't write until loadModpack has fetched data for this target at least once,
  // otherwise changing `target` would snapshot stale state as the new target's draft.
  useEffect(() => {
    if (!loadedTargets.current.has(target)) return
    drafts.current[target] = {
      name: packName,
      description: packDescription,
      version: packVersion,
      battlemetricsId: packBattlemetricsId,
      mods: modpackMods,
      configs: modpackConfigs,
    }
  }, [target, packName, packDescription, packVersion, packBattlemetricsId, modpackMods, modpackConfigs])

  /**
   * Preenche o modpack atual com os mods e configs do Mundo 1 — atalho para montar um mundo
   * novo, que na prática começa como uma variação do principal. Copia SÓ a lista (nome,
   * descrição e versão deste modpack ficam como estão) e não publica nada.
   *
   * Prefere o rascunho do Mundo 1 já aberto nesta sessão (que pode ter edições ainda não
   * publicadas, o que o admin acabou de ver na tela); só busca no backend se ele nunca foi
   * aberto aqui. Clona os objetos para os dois modpacks não passarem a editar a mesma lista.
   */
  async function handleCopyFromWorld1() {
    setError('')
    setCopyingWorld1(true)
    try {
      const draft = loadedTargets.current.has('main') ? drafts.current['main'] : undefined
      let mods = draft?.mods
      let configs = draft?.configs
      if (!draft) {
        let data: Modpack | null = null
        try {
          data = await getPublicModpack(backendUrl || undefined, true, 'main')
        } catch { /* backend fora do ar: tenta o raw do GitHub abaixo */ }
        if (!data) data = await fetchModpackFromUrl(buildModpackRawUrl(modpackRepo, modpackBranch, 'main'))
        mods = data.mods || []
        configs = data.configs || []
      }
      setModpackMods((mods || []).map(m => ({ ...m })))
      setModpackConfigs((configs || []).map(c => ({ ...c })))
      loadedTargets.current.add(target)
      setConfirmCopy(false)
    } catch (err: any) {
      setError(err?.message || 'Falha ao copiar o modpack do Mundo 1')
    } finally {
      setCopyingWorld1(false)
    }
  }

  const loadMods = useCallback(() => {
    setLoadingMods(true)
    setModsError('')
    fetchAllMods()
      .then(mods => {
        setAllMods(mods)
        setVisibleCount(PAGE_SIZE)
      })
      .catch((err: any) => setModsError(err?.message || 'Erro ao carregar mods do Thunderstore'))
      .finally(() => setLoadingMods(false))
  }, [])

  useEffect(() => {
    if (allMods.length > 0) return
    loadMods()
  }, [allMods.length, loadMods])

  const availableCategories = useMemo(() => {
    const cats = new Set<string>()
    allMods.forEach(m => (m.categories || []).forEach(c => cats.add(c)))
    return Array.from(cats).sort()
  }, [allMods])

  const filteredMods = useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    let source = allMods
    if (!showDeprecated) {
      source = source.filter(m => !m.is_deprecated)
    }
    if (q) {
      source = source.filter(m =>
        m.name.toLowerCase().includes(q) ||
        m.owner.toLowerCase().includes(q) ||
        (m.latest.description?.toLowerCase().includes(q) ?? false)
      )
    }
    if (categoryFilter) {
      source = source.filter(m => (m.categories || []).includes(categoryFilter))
    }
    const sorted = [...source]
    if (sortBy === 'downloads') sorted.sort((a, b) => (b.total_downloads ?? 0) - (a.total_downloads ?? 0))
    else if (sortBy === 'rating') sorted.sort((a, b) => (b.rating_score ?? 0) - (a.rating_score ?? 0))
    else if (sortBy === 'updated') sorted.sort((a, b) => (b.date_updated ?? '').localeCompare(a.date_updated ?? ''))
    else if (sortBy === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
    return sorted
  }, [allMods, searchQuery, sortBy, categoryFilter, showDeprecated])

  // Reset visible count when filter changes
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [searchQuery, sortBy, categoryFilter, showDeprecated])

  /** Divide uma referência de dependência do Thunderstore ("Owner-Name-Version") em partes. */
  function parseDependencyRef(ref: string): { owner: string; name: string; version: string } | null {
    const parts = ref.split('-')
    if (parts.length < 3) return null
    return { owner: parts[0], name: parts.slice(1, -1).join('-'), version: parts[parts.length - 1] }
  }

  function handleAddThunderstoreMod(ts: ThunderstoreMod) {
    const alreadyPresent = (owner: string, name: string) =>
      modpackMods.some(m => m.source === 'thunderstore' && m.namespace === owner && m.name === name)

    if (alreadyPresent(ts.owner, ts.name)) return

    // Coleta o mod escolhido e, recursivamente, suas dependências (nas versões fixadas pelo manifesto).
    const toAdd: Mod[] = []
    const seen = new Set<string>()

    function collect(mod: ThunderstoreMod, versionOverride?: string) {
      const key = `${mod.owner}-${mod.name}`
      if (seen.has(key) || alreadyPresent(mod.owner, mod.name)) return
      seen.add(key)
      const version = versionOverride || selectedVersions[mod.full_name] || mod.latest.version_number
      const downloadUrl = getDownloadUrl(mod.owner, mod.name, version)
      toAdd.push({
        name: mod.name,
        source: 'thunderstore',
        namespace: mod.owner,
        version,
        downloadUrl,
        description: mod.latest.description?.slice(0, 120),
      })
      for (const depRef of mod.latest.dependencies || []) {
        const parsed = parseDependencyRef(depRef)
        if (!parsed) continue
        const depMod = allMods.find(m => m.owner === parsed.owner && m.name === parsed.name)
        if (depMod) collect(depMod, parsed.version)
      }
    }

    collect(ts)
    if (toAdd.length === 0) return
    setModpackMods(prev => [...prev, ...toAdd])

    // Scan each newly added mod's zip for bundled config files in background (Electron only)
    const w = window as any
    if (w?.Hofheim?.mods?.readConfigsFromZip) {
      for (const mod of toAdd) {
        setScanningMods(prev => new Set(prev).add(mod.name))
        w.Hofheim.mods.readConfigsFromZip({ url: mod.downloadUrl })
          .then((result: { success: boolean; configs?: { filename: string; installPath: string; content: string }[]; error?: string }) => {
            if (result.success && result.configs && result.configs.length > 0) {
              setSuggestedConfigs(prev => {
                const existing = prev.find(s => s.modName === mod.name)
                if (existing) return prev
                return [...prev, { modName: mod.name, configs: result.configs! }]
              })
            }
          })
          .catch(() => {})
          .finally(() => setScanningMods(prev => { const s = new Set(prev); s.delete(mod.name); return s }))
      }
    }
  }

  function handleAddPrivateMod() {
    if (!privName.trim() || !privFilename.trim()) return
    setModpackMods([...modpackMods, {
      name: privName.trim(),
      source: 'private',
      filename: privFilename.trim(),
      downloadUrl: `/mods/private/${privFilename.trim()}`,
    }])
    setPrivName('')
    setPrivFilename('')
  }

  const loadRepoMods = useCallback(() => {
    if (!adminToken) return
    setRepoLoading(true)
    setRepoError('')
    listPrivateMods(adminToken, backendUrl)
      .then(mods => setRepoMods(mods))
      .catch((err: any) => setRepoError(err?.message || 'Erro ao listar mods privados'))
      .finally(() => setRepoLoading(false))
  }, [adminToken, backendUrl])

  async function handlePickFile() {
    if (!window.Hofheim?.mods?.pickModFile) return
    // Escolhe o arquivo SEM lê-lo (mods de 300MB+ não passam por IPC como base64).
    // Recebe só um token opaco + metadados; o upload streama do main direto pro Worker.
    const file = await window.Hofheim.mods.pickModFile()
    if (!file) return
    setPendingFile(file)
    setUploadError('')
    if (!privName.trim()) {
      setPrivName(file.filename.replace(/\.(zip|dll|mdb)$/i, ''))
    }
    setPrivFilename(file.filename)
  }

  async function handleUploadAndAdd() {
    if (!pendingFile || !adminToken) return
    setUploading(true)
    setUploadError('')
    setUploadProgress(0)
    // Progresso vindo do main (upload multipart via Worker → R2).
    window.Hofheim.mods.onUploadProgress(({ sent, total }) => {
      setUploadProgress(total > 0 ? Math.round((sent / total) * 100) : 0)
    })
    try {
      const res = await window.Hofheim.mods.uploadPrivateModStream({
        token: pendingFile.token,
        backendUrl: streamBackendUrl,
        authToken: adminToken,
      })
      if (!res.success || !res.filename) throw new Error(res.error || 'Falha no upload')
      const name = privName.trim() || res.filename.replace(/\.(zip|dll|mdb)$/i, '')
      setModpackMods(prev => [...prev, {
        name,
        source: 'private',
        filename: res.filename!,
        downloadUrl: res.downloadUrl || `/mods/private/${res.filename}`,
      }])
      setPendingFile(null)
      setPrivName('')
      setPrivFilename('')
      loadRepoMods()
    } catch (err: any) {
      setUploadError(err?.message || 'Erro ao fazer upload')
    } finally {
      window.Hofheim.mods.offUploadProgress()
      setUploading(false)
      setUploadProgress(0)
    }
  }

  function handleAddFromRepo(entry: PrivateModEntry) {
    const name = entry.filename.replace(/\.(zip|dll|mdb)$/i, '')
    if (modpackMods.some(m => m.source === 'private' && m.filename === entry.filename)) return
    setModpackMods(prev => [...prev, {
      name,
      source: 'private',
      filename: entry.filename,
      downloadUrl: `/mods/private/${entry.filename}`,
    }])
  }

  function handleRemoveMod(index: number) {
    setModpackMods(modpackMods.filter((_, i) => i !== index))
  }

  function handleToggleOptional(index: number) {
    setModpackMods(modpackMods.map((m, i) => i === index ? { ...m, optional: !m.optional } : m))
  }

  function handleUpdateModVersion(index: number, version: string) {
    setModpackMods(modpackMods.map((m, i) => {
      if (i !== index) return m
      const updated = { ...m, version }
      if (m.source === 'thunderstore' && m.namespace) {
        updated.downloadUrl = getDownloadUrl(m.namespace, m.name, version)
      }
      return updated
    }))
  }

  // Scan the selected mod's zip for config files whenever cfgMod changes
  useEffect(() => {
    if (!cfgMod) {
      setCfgDiscoveredFiles([])
      return
    }
    // Serve from cache if available
    if (configScanCache.current[cfgMod]) {
      setCfgDiscoveredFiles(configScanCache.current[cfgMod])
      return
    }
    const mod = modpackMods.find(m => m.name === cfgMod)
    if (!mod || mod.source !== 'thunderstore' || !mod.downloadUrl) {
      setCfgDiscoveredFiles([])
      return
    }
    const w = window as any
    if (!w?.Hofheim?.mods?.readConfigsFromZip) return
    setCfgScanLoading(true)
    setCfgDiscoveredFiles([])
    w.Hofheim.mods.readConfigsFromZip({ url: mod.downloadUrl })
      .then((result: { success: boolean; configs?: { filename: string; installPath: string; content: string }[] }) => {
        const files = result.success ? (result.configs ?? []) : []
        configScanCache.current[cfgMod] = files
        setCfgDiscoveredFiles(files)
      })
      .catch(() => setCfgDiscoveredFiles([]))
      .finally(() => setCfgScanLoading(false))
  }, [cfgMod, modpackMods])

  function handleAddConfig() {
    if (!cfgFilename.trim()) return
    setModpackConfigs([...modpackConfigs, {
      mod: cfgMod.trim(),
      filename: cfgFilename.trim(),
      installPath: cfgInstallPath.trim() || `BepInEx/config/${cfgFilename.trim()}`,
      content: cfgContent,
    }])
    setCfgMod('')
    setCfgFilename('')
    setCfgInstallPath('')
    setCfgContent('')
  }

  function handleRemoveConfig(index: number) {
    setModpackConfigs(modpackConfigs.filter((_, i) => i !== index))
  }

  async function handlePickLocalDir() {
    const dir = await window.Hofheim.fs.pickDir()
    if (dir) {
      setLocalConfigDir(dir)
      setLocalConfigFiles([])
      setLocalConfigError('')
      setLocalSelectedFile('')
      setLocalFileContent('')
      // Pasta nova: a lista anterior (e qualquer plano de espelhamento feito sobre ela) não vale
      // mais — aplicar um plano da pasta antiga removeria configs com base em outro diretório.
      setLocalUnknownFiles([])
      setMirrorPlan(null)
      setMirrorResult('')
      setMirrorError('')
      onSave?.({ adminProfilePath: dir })
    }
  }

  /**
   * Lista os configs de uma pasta. Recebe o caminho por parâmetro (em vez de ler o estado)
   * porque o drop precisa listar a pasta arrastada no MESMO clique — o setLocalConfigDir
   * ainda não teria chegado ao estado.
   */
  async function listLocalConfigs(dir: string) {
    if (!dir) return
    setLocalConfigLoading(true)
    setLocalConfigError('')
    setLocalConfigFiles([])
    setLocalSelectedFile('')
    setLocalFileContent('')
    const result = await window.Hofheim.fs.listDir({ dir })
    if (result?.success) {
      setLocalConfigFiles(result.files ?? [])
      setLocalUnknownFiles(result.unknown ?? [])
      // Relistar invalida um plano de espelhamento anterior: ele foi calculado sobre a
      // lista antiga e aplicá-lo agora removeria/adicionaria com base em dados velhos.
      setMirrorPlan(null)
      setMirrorResult('')
      setMirrorError('')
      onSave?.({ adminProfilePath: dir })
    } else {
      setLocalConfigError(result?.error || 'Erro ao listar arquivos')
    }
    setLocalConfigLoading(false)
  }

  const handleListLocalConfigs = () => listLocalConfigs(localConfigDir.trim())

  /**
   * Arrastar a pasta `config` para dentro do card. O caminho da pasta vem do `path` do File
   * (Electron ≤31 preenche isso no renderer; foi removido no 32, onde o certo é webUtils).
   * Como o drop não passa pelo diálogo do SO, o main precisa liberar a pasta explicitamente
   * (fs:allowDroppedConfigDir) antes de qualquer leitura — e ele só aceita pasta chamada
   * `config`, o que também barra o erro de arrastar a `BepInEx` inteira.
   */
  async function handleDropLocalDir(e: React.DragEvent) {
    e.preventDefault()
    setLocalDirDragOver(false)
    setLocalConfigError('')

    // Duas formas de chegar ao File: `files` (o normal) e `items[].getAsFile()` — dependendo
    // da versão do Chromium, uma PASTA arrastada aparece só numa das duas.
    const fromFiles = e.dataTransfer?.files?.[0] as (File & { path?: string }) | undefined
    const fromItems = Array.from(e.dataTransfer?.items || [])
      .filter(i => i.kind === 'file')
      .map(i => i.getAsFile() as (File & { path?: string }) | null)
      .find(f => !!f?.path)
    const dirPath = fromFiles?.path || fromItems?.path
    if (!dirPath) {
      setLocalConfigError('Não foi possível ler o caminho da pasta arrastada. Use o botão Buscar.')
      return
    }

    const allowed = await window.Hofheim.fs.allowDroppedConfigDir({ dirPath })
    if (!allowed?.success || !allowed.dirPath) {
      setLocalConfigError(allowed?.error || 'Não foi possível usar essa pasta')
      return
    }
    setLocalConfigDir(allowed.dirPath)
    await listLocalConfigs(allowed.dirPath)
  }

  /**
   * Quantos arquivos listados ainda não estão no modpack (rótulo do "Adicionar tudo").
   * Mesmo critério de `handleAddAllLocalToModpack`, pra o número bater com o que ele faz.
   */
  const localPendingCount = useMemo(
    () => localConfigFiles.filter(f =>
      !modpackConfigs.some(c => c.filename === f || c.installPath === `BepInEx/config/${f}`)
    ).length,
    [localConfigFiles, modpackConfigs],
  )

  function localFilePath(filename: string) {
    const dir = localConfigDir.replace(/[\\/]+$/, '')
    const sep = dir.includes('\\') ? '\\' : '/'
    return dir + sep + filename
  }

  async function handleOpenLocalFile(filename: string) {
    setLocalSelectedFile(filename)
    setLocalFileContent('')
    setLocalUploadError('')
    // Binário não é lido como texto (corromperia e o preview é inútil) — os bytes só são
    // lidos na hora de enviar ao R2, e direto do disco pelo main process
    // (configs.uploadFileStream em handleAddLocalToModpack); nunca passam por aqui.
    if (isBinaryConfigPath(filename)) return
    setLocalFileLoading(true)
    const result = await window.Hofheim.fs.readFile({ filePath: localFilePath(filename) })
    if (result?.success) {
      setLocalFileContent(result.content ?? '')
    } else {
      setLocalFileContent('// Erro ao ler arquivo: ' + (result?.error || ''))
    }
    setLocalFileLoading(false)
  }

  async function handleSaveLocalFile() {
    if (!localSelectedFile || !localConfigDir) return
    setLocalFileSaving(true)
    await window.Hofheim.fs.writeFile({ filePath: localFilePath(localSelectedFile), content: localFileContent })
    setLocalFileSaving(false)
    setLocalFileSaved(true)
    setTimeout(() => setLocalFileSaved(false), 2000)
  }

  async function handleAddLocalToModpack() {
    if (!localSelectedFile) return
    const installPath = `BepInEx/config/${localSelectedFile}`

    // Config BINÁRIO (ex.: spritesheet .png de emoji): não pode virar string JSON —
    // seria corrompido em UTF-8. Lê os bytes crus (base64), sobe pro R2 e guarda a
    // URL no content. O player baixa os bytes via applyConfig (binary-safe).
    if (isBinaryConfigPath(localSelectedFile)) {
      if (!adminToken) {
        setLocalUploadError('Faça login de admin para enviar configs binários.')
        return
      }
      setLocalUploading(true)
      setLocalUploadError('')
      try {
        // Basename: o backend exige nome simples (sem `/`) na key do R2. O installPath
        // preserva a subpasta pra o player gravar no lugar certo.
        const up = await window.Hofheim.configs.uploadFileStream({
          filePath: localFilePath(localSelectedFile),
          filename: configUploadName(localSelectedFile),
          backendUrl: streamBackendUrl,
          authToken: adminToken,
        })
        if (!up.success || !up.url) throw new Error(up.error || 'Falha ao enviar o arquivo')
        const url = up.url
        // Substitui uma entrada existente com o mesmo installPath (ex.: corrigir um
        // binário antes corrompido) em vez de só pular.
        setModpackConfigs(prev => {
          const next = prev.filter(c => c.installPath !== installPath)
          return [...next, { mod: '', filename: localSelectedFile, installPath, content: url }]
        })
      } catch (err: any) {
        setLocalUploadError('Falha ao enviar config binário: ' + (err.message || ''))
      } finally {
        setLocalUploading(false)
      }
      return
    }

    // Config de texto: embute o conteúdo direto no modpack.
    if (!localFileContent) return
    if (modpackConfigs.some(c => c.filename === localSelectedFile)) return
    setModpackConfigs(prev => [...prev, {
      mod: '',
      filename: localSelectedFile,
      installPath,
      content: localFileContent,
    }])
  }

  /**
   * Adiciona de uma vez os arquivos listados que AINDA NÃO estão no modpack.
   *
   * Nunca toca no que já está lá: quem já foi adicionado é pulado inteiro — não
   * duplica, não relê do disco e (no caso de binário) não reenvia pro R2. Mesma
   * regra do botão individual, que fica desabilitado como "✓ No modpack". Atualizar
   * um config já adicionado continua sendo feito na aba Configs (ou removendo e
   * adicionando de novo).
   *
   * Texto entra embutido; binário sobe pro R2 (precisa de login de admin). `.zip` é
   * pulado de propósito — por aqui viraria um arquivo solto e carregado inteiro na
   * memória; o card "Pacote de Configs (.zip)" é o caminho certo pra pacote extraível.
   */
  async function handleAddAllLocalToModpack() {
    // Pula por filename (mesmo critério do selo "no modpack" e do botão individual) e
    // também por installPath, pra nunca sobrescrever uma entrada já existente.
    const isInModpack = (f: string) =>
      modpackConfigs.some(c => c.filename === f || c.installPath === `BepInEx/config/${f}`)
    const pending = localConfigFiles.filter(f => !isInModpack(f))
    if (pending.length === 0) return
    setLocalAddAllRunning(true)
    setLocalUploadError('')
    setLocalAddAllResult('')
    setLocalAddAllProgress({ done: 0, total: pending.length })

    const added: ModConfig[] = []
    const skippedZip: string[] = []
    const skippedNoToken: string[] = []
    const skippedEmpty: string[] = []
    const failed: string[] = []

    for (const f of pending) {
      const installPath = `BepInEx/config/${f}`
      try {
        if (isBinaryConfigPath(f)) {
          if (/\.zip$/i.test(f)) { skippedZip.push(f); continue }
          if (!adminToken) { skippedNoToken.push(f); continue }
          const up = await window.Hofheim.configs.uploadFileStream({
            filePath: localFilePath(f),
            filename: configUploadName(f),
            backendUrl: streamBackendUrl,
            authToken: adminToken,
          })
          if (!up.success || !up.url) throw new Error(up.error || 'falha ao enviar')
          added.push({ mod: '', filename: f, installPath, content: up.url })
        } else {
          const read = await window.Hofheim.fs.readFile({ filePath: localFilePath(f) })
          if (!read.success) throw new Error(read.error || 'falha ao ler')
          // Arquivo vazio é pulado igual no botão individual (`if (!localFileContent) return`):
          // publicar um config vazio zeraria o do player.
          if (!read.content) { skippedEmpty.push(f); continue }
          added.push({ mod: '', filename: f, installPath, content: read.content })
        }
      } catch {
        failed.push(f)
      } finally {
        setLocalAddAllProgress(p => ({ ...p, done: p.done + 1 }))
      }
    }

    // Append puro: `pending` já garantiu que nada aqui colide com o que está no modpack.
    if (added.length > 0) setModpackConfigs(prev => [...prev, ...added])

    const parts = [`${added.length} adicionado${added.length === 1 ? '' : 's'}`]
    if (skippedNoToken.length) parts.push(`${skippedNoToken.length} binário(s) pulado(s) — faça login de admin`)
    if (skippedZip.length) parts.push(`${skippedZip.length} .zip pulado(s) — use o card "Pacote de Configs (.zip)"`)
    if (skippedEmpty.length) parts.push(`${skippedEmpty.length} vazio(s) pulado(s)`)
    if (failed.length) parts.push(`${failed.length} com erro: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '...' : ''}`)
    setLocalAddAllResult(parts.join(' · '))
    setLocalAddAllRunning(false)
  }

  /**
   * ── Espelhar pasta local no modpack ────────────────────────────────────────────────────
   * Etapa 1 (plano): compara a pasta escolhida com os configs do modpack e diz exatamente o
   * que vai mudar, sem tocar em nada. Só lê do disco — nenhum upload acontece aqui.
   *
   * O mapeamento é posicional: `Icons/x.png` na pasta → `BepInEx/config/Icons/x.png` no perfil
   * do player. É o que faz a estrutura ser replicada igual, em vez de cair solto na raiz.
   *
   * Binário não é lido: o hash sai do main process em streaming e é comparado com o `{sha8}-`
   * da URL do R2 que já está no modpack (a key é content-addressed). Igual = não reenvia.
   */
  async function handlePlanMirror() {
    if (!localConfigDir.trim()) return
    setMirrorRunning(true)
    setMirrorError('')
    setMirrorResult('')
    setMirrorPlan(null)
    setMirrorProgress({ done: 0, total: localConfigFiles.length })

    try {
      const byPath = new Map(modpackConfigs.filter(c => !c.extract).map(c => [c.installPath, c]))
      const plan: MirrorPlan = {
        toAdd: [], toUpdate: [], unchanged: 0, toRemove: [],
        skippedZip: [], skippedEmpty: [], skippedUnknownExt: [...localUnknownFiles],
        keptExtract: modpackConfigs.filter(c => c.extract).length,
        keptOutside: modpackConfigs.filter(c => !c.extract && !c.installPath.startsWith(CONFIG_PREFIX)).length,
      }

      for (const rel of localConfigFiles) {
        const existing = byPath.get(CONFIG_PREFIX + rel)
        try {
          // .zip solto viraria um arquivo inerte no perfil; pacote extraível tem card próprio.
          if (/\.zip$/i.test(rel)) { plan.skippedZip.push(rel); continue }

          if (isBinaryConfigPath(rel)) {
            const h = await window.Hofheim.fs.hashFile({ filePath: localFilePath(rel) })
            if (!h.success || !h.sha256) throw new Error(h.error || 'falha ao ler')
            if (!h.size) { plan.skippedEmpty.push(rel); continue }
            const sha8 = h.sha256.slice(0, 8)
            if (existing && isUrlContent(existing) && existing.content.includes(`/configs/${sha8}-`)) {
              plan.unchanged++
            } else if (existing) {
              plan.toUpdate.push({ rel, binary: true, sha256: h.sha256 })
            } else {
              plan.toAdd.push({ rel, binary: true, sha256: h.sha256 })
            }
          } else if (existing && isUrlContent(existing)) {
            // Texto GRANDE que o publish já mandou pro R2: o content virou URL, então comparar
            // com o texto do disco daria "diferente" sempre e o espelho re-inlinaria (e o publish
            // re-subiria) esses arquivos a cada vez. A key do R2 é content-addressed do mesmo
            // arquivo, então o hash resolve igual ao caso binário.
            const h = await window.Hofheim.fs.hashFile({ filePath: localFilePath(rel) })
            if (!h.success || !h.sha256) throw new Error(h.error || 'falha ao ler')
            if (!h.size) { plan.skippedEmpty.push(rel); continue }
            if (existing.content.includes(`/configs/${h.sha256.slice(0, 8)}-`)) plan.unchanged++
            else plan.toUpdate.push({ rel, binary: false })
          } else {
            const read = await window.Hofheim.fs.readFile({ filePath: localFilePath(rel) })
            if (!read.success) throw new Error(read.error || 'falha ao ler')
            if (!read.content) { plan.skippedEmpty.push(rel); continue }
            if (existing && existing.content === read.content) plan.unchanged++
            else if (existing) plan.toUpdate.push({ rel, binary: false })
            else plan.toAdd.push({ rel, binary: false })
          }
        } finally {
          setMirrorProgress(p => ({ ...p, done: p.done + 1 }))
        }
      }

      // Sobrou no modpack e não existe na pasta = removido. Só considera o que a pasta
      // REALMENTE representa: entradas fora de BepInEx/config/ e pacotes .zip não são
      // arquivos desta pasta e ficam intactos. Extensão não reconhecida conta como
      // existente (o arquivo está lá, só não foi analisado) pra não apagar a entrada dele.
      const onDisk = new Set([...localConfigFiles, ...localUnknownFiles])
      for (const c of modpackConfigs) {
        if (c.extract || !c.installPath.startsWith(CONFIG_PREFIX)) continue
        const rel = c.installPath.slice(CONFIG_PREFIX.length)
        if (!onDisk.has(rel)) plan.toRemove.push(c.installPath)
      }

      setMirrorPlan(plan)
    } catch (err: any) {
      setMirrorError('Falha ao calcular o espelhamento: ' + (err?.message || ''))
    } finally {
      setMirrorRunning(false)
    }
  }

  /**
   * Etapa 2: executa o plano. Sobe ao R2 só os binários que mudaram, relê os textos que
   * mudaram, e monta a lista final ordenada por installPath. Preserva o campo `mod`
   * (informativo) das entradas que já existiam.
   *
   * Nada é publicado aqui: a alteração fica no rascunho do editor e vai pro ar no Publicar,
   * que é onde o admin confere o resumo.
   */
  async function handleApplyMirror() {
    const plan = mirrorPlan
    if (!plan) return
    const work = [...plan.toAdd, ...plan.toUpdate]
    if (work.some(w => w.binary) && !adminToken) {
      setMirrorError('Faça login de admin para enviar os configs binários ao R2.')
      return
    }

    setMirrorRunning(true)
    setMirrorError('')
    setMirrorProgress({ done: 0, total: work.length })

    const byPath = new Map(modpackConfigs.map(c => [c.installPath, c]))
    const applied = new Map<string, ModConfig>()
    const failed: string[] = []

    for (const item of work) {
      const installPath = CONFIG_PREFIX + item.rel
      const prev = byPath.get(installPath)
      try {
        if (item.binary) {
          const up = await window.Hofheim.configs.uploadFileStream({
            filePath: localFilePath(item.rel),
            filename: configUploadName(item.rel),
            backendUrl: streamBackendUrl,
            authToken: adminToken!,
          })
          if (!up.success || !up.url) throw new Error(up.error || 'falha ao enviar')
          applied.set(installPath, { mod: prev?.mod || '', filename: item.rel, installPath, content: up.url })
        } else {
          const read = await window.Hofheim.fs.readFile({ filePath: localFilePath(item.rel) })
          if (!read.success || !read.content) throw new Error(read.error || 'falha ao ler')
          applied.set(installPath, { mod: prev?.mod || '', filename: item.rel, installPath, content: read.content })
        }
      } catch {
        failed.push(item.rel)
      } finally {
        setMirrorProgress(p => ({ ...p, done: p.done + 1 }))
      }
    }

    // Remoções só valem para o que o plano previu E que não acabou de ser reescrito.
    // Um item que falhou o upload mantém a entrada ANTIGA (melhor um config desatualizado
    // no player do que nenhum).
    const removing = new Set(plan.toRemove)
    setModpackConfigs(prev => {
      const next = prev
        .filter(c => !removing.has(c.installPath) || applied.has(c.installPath))
        .map(c => applied.get(c.installPath) || c)
      const existingPaths = new Set(next.map(c => c.installPath))
      for (const [p, cfg] of applied) if (!existingPaths.has(p)) next.push(cfg)
      return next.sort((a, b) => a.installPath.localeCompare(b.installPath))
    })

    const parts: string[] = []
    const addedOk = plan.toAdd.filter(a => applied.has(CONFIG_PREFIX + a.rel)).length
    const updatedOk = plan.toUpdate.filter(u => applied.has(CONFIG_PREFIX + u.rel)).length
    if (addedOk) parts.push(`${addedOk} adicionado(s)`)
    if (updatedOk) parts.push(`${updatedOk} atualizado(s)`)
    if (plan.toRemove.length) parts.push(`${plan.toRemove.length} removido(s)`)
    if (plan.unchanged) parts.push(`${plan.unchanged} sem mudança`)
    if (failed.length) parts.push(`${failed.length} com erro: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}`)
    parts.push('revise e clique em Publicar')
    setMirrorResult(parts.join(' · '))
    setMirrorPlan(null)
    setMirrorRunning(false)
  }

  /** Normaliza a pasta destino do zip: relativa ao perfil, sem barras nas pontas. */
  const normalizedZipDest = (zipDest.trim() || 'BepInEx/config').replace(/^[\\/]+|[\\/]+$/g, '').replace(/\\/g, '/')

  async function handlePickConfigZip() {
    setZipError('')
    const picked = await window.Hofheim.configs.pickZip()
    if (!picked) return
    if ('error' in picked) { setZipError(picked.error); return }
    setZipPick(picked)
  }

  /**
   * Sobe o .zip pro R2 (multipart, feito no main) e adiciona ao modpack como pacote extraído.
   * O modpack.json guarda só a URL — o zip nunca é embutido, então não pesa no limite de 5 MB.
   */
  async function handleUploadConfigZip() {
    if (!zipPick) return
    if (!adminToken) { setZipError('Faça login de admin para enviar o pacote.'); return }
    const dest = normalizedZipDest
    setZipUploading(true)
    setZipError('')
    setZipProgress(0)
    window.Hofheim.configs.onUploadProgress(({ sent, total }) => {
      setZipProgress(total > 0 ? Math.round((sent / total) * 100) : 0)
    })
    try {
      const res = await window.Hofheim.configs.uploadZipStream({
        token: zipPick.token,
        backendUrl: streamBackendUrl,
        authToken: adminToken,
      })
      if (!res.success || !res.url) throw new Error(res.error || 'Falha no upload')
      // Substitui a entrada anterior do MESMO pacote no MESMO destino (reenvio de uma versão
      // nova das texturas) em vez de duplicar.
      setModpackConfigs(prev => [
        ...prev.filter(c => !(c.extract && c.filename === zipPick.filename && c.installPath === dest)),
        { mod: '', filename: zipPick.filename, installPath: dest, content: res.url!, extract: true },
      ])
      setZipPick(null)
    } catch (err: any) {
      setZipError(err?.message || 'Erro ao enviar o pacote')
    } finally {
      window.Hofheim.configs.offUploadProgress()
      setZipUploading(false)
      setZipProgress(0)
    }
  }

  /** Constrói o objeto Modpack com o estado atual do draft (mods só como referência). */
  function buildCurrentModpack(): Modpack {
    return {
      version: packVersion,
      name: packName,
      description: packDescription,
      mods: modpackMods.map(stripModToReference),
      configs: modpackConfigs,
      battlemetricsId: packBattlemetricsId || undefined,
    }
  }

  /** Aplica um modpack importado ao estado do editor. */
  function applyImportedModpack(data: Modpack) {
    setPackName(data.name || '')
    setPackDescription(data.description || '')
    setPackVersion(data.version || '1.0.0')
    setPackBattlemetricsId(data.battlemetricsId || '')
    setModpackMods(data.mods || [])
    setModpackConfigs(data.configs || [])
    // Mark as loaded so draft sync works correctly
    loadedTargets.current.add(target)
  }

  function handleExportCode() {
    const json = JSON.stringify(buildCurrentModpack(), null, 2)
    const code = 'Hofheim-v1-' + btoa(encodeURIComponent(json))
    setExportCode(code)
  }

  async function handleExportFile() {
    const pack = buildCurrentModpack()
    const json = JSON.stringify(pack, null, 2)
    const filename = `${pack.name.replace(/\s+/g, '_') || 'modpack'}.Hofheim`
    await window.Hofheim.fs.saveFileDialog({ filename, content: json })
  }

  async function handleImportCode() {
    setImportError('')
    setImportSuccess('')
    const raw = importCodeInput.trim()
    if (!raw) return
    setImporting('code')
    try {
      // ── Formato Hofheim ──────────────────────────────────────────────────────
      if (raw.startsWith('Hofheim-v1-')) {
        try {
          const data = JSON.parse(decodeURIComponent(atob(raw.slice('Hofheim-v1-'.length)))) as Modpack
          if (!data.mods) throw new Error('campo "mods" ausente')
          applyImportedModpack(data)
          setImportCodeInput('')
          const cfgCount = data.configs?.length ?? 0
          setImportSuccess(`✓ ${data.mods.length} mod${data.mods.length !== 1 ? 's' : ''}${cfgCount ? ` e ${cfgCount} config${cfgCount !== 1 ? 's' : ''}` : ''} importados!`)
          setTimeout(() => setImportSuccess(''), 3000)
        } catch (err: any) {
          setImportError('Código Hofheim inválido: ' + (err.message || ''))
        }
        return
      }

      // ── Formato R2ModManager (código curto resolvido via API do Thunderstore) ──
      const r2Result = await window.Hofheim.mods.importR2Code({ code: raw })
      if (!r2Result.success || !r2Result.mods) {
        setImportError(r2Result.error || 'Formato não reconhecido. Use um código Hofheim (Hofheim-v1-…) ou R2ModManager.')
        return
      }
      await applyR2Result(r2Result.mods, r2Result.configs)
      setImportCodeInput('')
    } finally {
      setImporting('')
    }
  }

  /**
   * Converte o resultado de um perfil R2ModManager (código ou arquivo .r2z) para o
   * estado do editor. Reusado por importação por código e por arquivo .r2z, já que
   * ambos produzem a mesma estrutura { mods, configs } vinda do main process.
   *
   * Configs de TEXTO chegam em `content` (embutidos no modpack). Configs BINÁRIOS
   * (imagem/música/gif/fonte) chegam em `contentBase64` e são enviados ao R2 aqui;
   * o `content` final vira a URL pública. Requer login de admin para o upload.
   */
  async function applyR2Result(
    mods: { namespace: string; name: string; version: string }[],
    configs?: { filename: string; installPath: string; content?: string; contentBase64?: string }[],
  ) {
    const newMods: Mod[] = mods.map(({ namespace, name, version }) => {
      const ts = allMods.find(m => m.owner === namespace && m.name === name)
      return {
        name,
        source: 'thunderstore' as const,
        namespace,
        version,
        downloadUrl: getDownloadUrl(namespace, name, version),
        description: ts?.latest.description?.slice(0, 120),
      }
    })

    const matchMod = (filename: string) =>
      newMods.find(m =>
        filename.toLowerCase().includes(m.name.toLowerCase()) ||
        filename.toLowerCase().includes((m.namespace ?? '').toLowerCase())
      )?.name ?? ''

    const newConfigs: ModConfig[] = []
    let skippedBinaries = 0
    for (const cfg of configs ?? []) {
      if (cfg.contentBase64 != null) {
        // Config binário: sobe pro R2 e guarda a URL. Sem admin logado não dá pra
        // subir — conta como pulado e avisa no final (mods/text seguem normalmente).
        if (!adminToken) { skippedBinaries++; continue }
        try {
          const { url } = await uploadConfig(adminToken, configUploadName(cfg.installPath), base64ToBytes(cfg.contentBase64), backendUrl)
          newConfigs.push({ mod: matchMod(cfg.filename), filename: cfg.filename, installPath: cfg.installPath, content: url })
        } catch {
          skippedBinaries++
        }
      } else {
        newConfigs.push({ mod: matchMod(cfg.filename), filename: cfg.filename, installPath: cfg.installPath, content: cfg.content ?? '' })
      }
    }

    setModpackMods(newMods)
    if (newConfigs.length > 0) setModpackConfigs(newConfigs)
    loadedTargets.current.add(target)
    const cfgCount = newConfigs.length
    const warn = skippedBinaries > 0 ? ` (${skippedBinaries} binário(s) não enviado(s) — faça login de admin)` : ''
    setImportSuccess(`✓ ${newMods.length} mod${newMods.length !== 1 ? 's' : ''}${cfgCount ? ` e ${cfgCount} config${cfgCount !== 1 ? 's' : ''}` : ''} importados do R2!${warn}`)
    setTimeout(() => setImportSuccess(''), 4000)
  }

  async function handleImportR2File() {
    setImportError('')
    setImportSuccess('')
    const r2Result = await window.Hofheim.mods.pickAndImportR2File()
    if (!r2Result) return // usuário cancelou o diálogo
    // O spinner só liga DEPOIS do diálogo do OS (durante ele o usuário já vê a janela nativa).
    setImporting('r2')
    try {
      if (!r2Result.success || !r2Result.mods) {
        setImportError(r2Result.error || 'Não foi possível ler o arquivo .r2z.')
        return
      }
      await applyR2Result(r2Result.mods, r2Result.configs)
    } finally {
      setImporting('')
    }
  }

  async function handleImportFile() {
    setImportError('')
    setImportSuccess('')
    const text = await window.Hofheim.fs.pickJsonFile()
    if (!text) return
    setImporting('file')
    try {
      const data = JSON.parse(text) as Modpack
      if (!data.mods) throw new Error('campo "mods" ausente')
      applyImportedModpack(data)
      const cfgCount = data.configs?.length ?? 0
      setImportSuccess(`✓ ${data.mods.length} mod${data.mods.length !== 1 ? 's' : ''}${cfgCount ? ` e ${cfgCount} config${cfgCount !== 1 ? 's' : ''}` : ''} importados!`)
      setTimeout(() => setImportSuccess(''), 3000)
    } catch (err: any) {
      setImportError('Arquivo inválido: ' + (err.message || 'falha ao ler'))
    } finally {
      setImporting('')
    }
  }

  /** Monta o objeto Modpack publicável (mods só como referência) a partir dos configs dados. */
  function buildPublishPayload(configs: ModConfig[]): Modpack {
    return {
      version: packVersion,
      name: packName,
      description: packDescription,
      updatedAt: new Date().toISOString(),
      mods: modpackMods.map(stripModToReference),
      configs,
      battlemetricsId: packBattlemetricsId || undefined,
    }
  }

  /** Publica o modpack a partir da lista de configs dada (já enxuta, só metadados + URLs). */
  async function pushModpack(configs: ModConfig[]) {
    await publishModpack(adminToken!, target, buildPublishPayload(configs), undefined, backendUrl)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  const isUrlContent = (c: ModConfig) => /^https?:\/\//i.test((c.content || '').trim())
  /** Basename do installPath — o backend exige nome simples (sem `/`) na key do R2. */
  /**
   * Nome de arquivo pra key do R2. O backend exige `^[A-Za-z0-9._-]+\.ext$` (sem `/`, sem
   * espaço, sem acento). Pega o basename e troca qualquer caractere inválido por `_` — ex.:
   * "None resquicio default.yml" → "None_resquicio_default.yml". O installPath original
   * (com espaço/subpasta) é preservado no config pra o player gravar no lugar certo; a key
   * é content-addressed (hash8-nome), então o nome "limpo" não precisa bater com o original.
   */
  const configUploadName = (installPath: string) =>
    (installPath.split(/[\\/]/).pop() || installPath).replace(/[^A-Za-z0-9._-]+/g, '_')
  /** Base64 -> bytes crus, para o conteúdo que chega já codificado (ex.: import de código R2). */
  function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }

  /**
   * Fluxo de publish. O modpack.json tem limite de 5 MB no backend e deve carregar só
   * metadados + URLs — conteúdo pesado vai pro R2:
   *   • BINÁRIO embutido (content não-URL): os bytes inline estão corrompidos (foram lidos
   *     como UTF-8), então precisa reler o arquivo real do disco (pasta de configs local).
   *     Se não achar no disco, vira pendência e o banner oferece remover.
   *   • TEXTO grande: o content inline é válido, então sobe direto pro R2 (sem disco), do
   *     maior pro menor, até o JSON caber no orçamento.
   */
  async function runPublish(configsInput: ModConfig[]) {
    if (!adminToken) {
      setError('Sessão de admin expirada. Faça login novamente.')
      return
    }
    setPublishing(true)
    setError('')
    setUnresolvedBinaries([])
    try {
      let configs = configsInput
      const unresolved: { installPath: string; reason: string }[] = []
      const dir = localConfigDir.trim()
      const MAX_PUBLISH_BYTES = 4.5 * 1024 * 1024
      const payloadBytes = (cs: ModConfig[]) => byteLength(JSON.stringify(buildPublishPayload(cs)))
      const baseName = (ip: string) => ip.split(/[\\/]/).pop() || ip

      const inlineBinaries = configs.filter(c => !isUrlContent(c) && isBinaryConfigPath(c.installPath))

      // ── Plano de trabalho (pra barra de progresso REAL) ──────────────────────────
      // Simula o offload ANTES de começar pra saber quantos uploads vão rolar. O content
      // pesado vira um link curto, então usamos uma URL placeholder do tamanho de uma real.
      const URL_PLACEHOLDER = `${backendUrl || 'https://Hofheim.example'}/configs/00000000-placeholder-name.bin`
      const plannedBinaries = dir ? inlineBinaries.map(c => c.installPath) : []
      let sim = configs.map(c => plannedBinaries.includes(c.installPath) ? { ...c, content: URL_PLACEHOLDER } : c)
      const simSkip = new Set<string>()
      let plannedTextCount = 0
      while (payloadBytes(sim) > MAX_PUBLISH_BYTES) {
        const h = sim
          .filter(c => !isUrlContent(c) && !isBinaryConfigPath(c.installPath) && !simSkip.has(c.installPath))
          .sort((a, b) => byteLength(b.content) - byteLength(a.content))[0]
        if (!h) break
        if (!isTextConfigPath(h.installPath)) { simSkip.add(h.installPath); continue }
        plannedTextCount++
        sim = sim.map(x => x.installPath === h.installPath ? { ...x, content: URL_PLACEHOLDER } : x)
      }

      const total = plannedBinaries.length + plannedTextCount + 1 // +1 = publish final
      let done = 0
      const tick = (label: string) => setPublishProgress({ done, total, label })
      tick('Preparando publicação…')

      // 1. Binários embutidos → R2 lendo o arquivo REAL do disco (o inline está corrompido).
      for (const c of inlineBinaries) {
        if (!dir) {
          unresolved.push({ installPath: c.installPath, reason: 'binário sem pasta de configs local definida' })
          continue
        }
        tick(`Enviando ${baseName(c.installPath)} ao R2…`)
        const rel = c.installPath.replace(/^BepInEx[\\/]config[\\/]/, '')
        try {
          const up = await window.Hofheim.configs.uploadFileStream({
            filePath: localFilePath(rel),
            filename: configUploadName(c.installPath),
            backendUrl: streamBackendUrl,
            authToken: adminToken,
          })
          if (!up.success || !up.url) {
            unresolved.push({ installPath: c.installPath, reason: up.error || 'arquivo não encontrado no disco' })
          } else {
            const url = up.url
            configs = configs.map(x => x.installPath === c.installPath ? { ...x, content: url } : x)
          }
        } catch (err: any) {
          unresolved.push({ installPath: c.installPath, reason: err.message || 'falha ao enviar ao R2' })
        }
        done = Math.min(done + 1, total - 1)
      }

      // 2. Texto grande → R2 (a partir do content inline, válido), do maior pro menor,
      //    até o modpack.json caber no orçamento (< 5 MB do backend, com folga).
      const skip = new Set<string>() // installPaths já tentados sem sucesso (evita loop)
      while (payloadBytes(configs) > MAX_PUBLISH_BYTES) {
        const heaviest = configs
          .filter(c => !isUrlContent(c) && !isBinaryConfigPath(c.installPath) && !skip.has(c.installPath))
          .sort((a, b) => byteLength(b.content) - byteLength(a.content))[0]
        if (!heaviest) break // nada mais que dê pra offload
        // Extensão desconhecida (ex.: backup .bak): não é binário conhecido nem texto
        // reconhecido → o R2 rejeita e não cabe embutido. Vira pendência pra remover.
        if (!isTextConfigPath(heaviest.installPath)) {
          unresolved.push({ installPath: heaviest.installPath, reason: 'extensão não suportada no R2 e grande demais pra embutir — remova este config' })
          skip.add(heaviest.installPath)
          continue
        }
        tick(`Enviando ${baseName(heaviest.installPath)} ao R2…`)
        try {
          // Texto → bytes UTF-8 direto: sem base64 no caminho, o Worker só repassa ao R2.
          const bytes = new TextEncoder().encode(heaviest.content || '')
          const { url } = await uploadConfig(adminToken, configUploadName(heaviest.installPath), bytes, backendUrl)
          configs = configs.map(x => x.installPath === heaviest.installPath ? { ...x, content: url } : x)
        } catch (err: any) {
          unresolved.push({ installPath: heaviest.installPath, reason: 'falha ao subir texto ao R2: ' + (err.message || '') })
          skip.add(heaviest.installPath)
        }
        done = Math.min(done + 1, total - 1)
      }

      // Persiste as URLs resolvidas no editor (mesmo que ainda reste pendência).
      setModpackConfigs(configs)

      if (unresolved.length > 0) {
        setUnresolvedBinaries(unresolved.map(u => u.installPath))
        const top = unresolved.slice(0, 8).map(u => `• ${u.installPath} — ${u.reason}`).join('\n')
        const extra = unresolved.length > 8 ? `\n…e mais ${unresolved.length - 8}` : ''
        // Binário precisa da pasta local (reler bytes do disco); os demais (extensão não
        // suportada, ex.: backup .bak) são pra remover — o botão abaixo faz isso.
        const hasBinaryPending = unresolved.some(u => isBinaryConfigPath(u.installPath))
        const hint = hasBinaryPending && !dir
          ? `\nDefina a pasta de configs local (aba "Configs locais") pra enviar os binários, ou remova estes configs.`
          : `\nUse o botão abaixo pra removê-los e publicar (backups e afins não precisam ir no modpack).`
        setError(`${unresolved.length} config(s) não puderam ir pro R2:\n${top}${extra}${hint}`)
        setPublishProgress(null)
        setPublishing(false)
        return
      }

      const finalBytes = payloadBytes(configs)
      if (finalBytes > MAX_PUBLISH_BYTES) {
        setError(
          `O modpack ainda está grande demais (${(finalBytes / 1024 / 1024).toFixed(1)} MB) mesmo após enviar os ` +
          `configs pesados ao R2 — o peso restante é de metadados/mods. Reduza o conteúdo do modpack.`,
        )
        setPublishProgress(null)
        setPublishing(false)
        return
      }

      tick('Publicando modpack…')
      await pushModpack(configs)
      setPublishProgress({ done: total, total, label: 'Publicado!' })
    } catch (err: any) {
      setError(err.message)
      setPublishProgress(null)
    } finally {
      setPublishing(false)
      // deixa o "Publicado!" visível um instante antes de sumir (só limpa se ainda existir).
      setTimeout(() => setPublishProgress(prev => (prev && prev.label === 'Publicado!' ? null : prev)), 1500)
    }
  }

  function handlePublish() {
    void runPublish(modpackConfigs)
  }

  /** Remove os configs binários que não puderam ir pro R2 e publica sem eles. */
  function handleDropUnresolvedAndPublish() {
    const drop = new Set(unresolvedBinaries)
    const next = modpackConfigs.filter(c => !drop.has(c.installPath))
    setModpackConfigs(next)
    setUnresolvedBinaries([])
    void runPublish(next)
  }

  const visibleMods = filteredMods.slice(0, visibleCount)
  const hasMore = visibleCount < filteredMods.length

  /** Ícone do mod (só thunderstore tem): casa por owner/name no catálogo carregado. */
  const modIconFor = useCallback((mod: Mod): string | undefined => {
    if (mod.source !== 'thunderstore') return undefined
    return allMods.find(m => m.name === mod.name && m.owner === mod.namespace)?.latest.icon
  }, [allMods])

  // Lista do modpack filtrada pela busca, preservando o ÍNDICE ORIGINAL — os handlers
  // (remover/opcional/versão) indexam o array real, então não podem receber índice filtrado.
  const visibleModpackMods = useMemo(() => {
    const q = modpackFilter.toLowerCase().trim()
    const withIndex = modpackMods.map((mod, index) => ({ mod, index }))
    if (!q) return withIndex
    return withIndex.filter(({ mod }) =>
      mod.name.toLowerCase().includes(q) ||
      (mod.namespace?.toLowerCase().includes(q) ?? false) ||
      (mod.filename?.toLowerCase().includes(q) ?? false)
    )
  }, [modpackMods, modpackFilter])

  // Barra de progresso REAL do publish (uploads de config ao R2 + publish final).
  const publishProgressBar = publishProgress ? (
    <div style={{ marginTop: 12, maxWidth: 460 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, marginBottom: 5, color: 'var(--text-secondary)' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{publishProgress.label}</span>
        <span style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {Math.min(publishProgress.done, publishProgress.total)}/{publishProgress.total}
        </span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
        <div style={{
          height: '100%',
          width: `${Math.round((Math.min(publishProgress.done, publishProgress.total) / Math.max(publishProgress.total, 1)) * 100)}%`,
          background: 'var(--accent-blue)',
          borderRadius: 4,
          transition: 'width 0.25s ease',
        }} />
      </div>
    </div>
  ) : null

  return (
    <div className="admin-view modpack-editor" ref={rootRef}>
      {showScrollDown && (
        <button
          type="button"
          className="scroll-to-bottom-fab"
          onClick={scrollToBottom}
          title="Ir para o fim da página (botão Publicar)"
        >
          ↓ Ir para Publicar
        </button>
      )}
      <div className="admin-header">
        <h1>Editor de Modpack</h1>
        <p className="text-secondary">Navegue mods do Thunderstore e monte seu modpack.</p>
      </div>

      {error && (
        <div className="error-banner" style={{ whiteSpace: 'pre-line' }}>
          {error}
          {unresolvedBinaries.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <button
                className="btn-secondary"
                style={{ fontSize: 13 }}
                onClick={handleDropUnresolvedAndPublish}
                disabled={publishing}
              >
                Remover {unresolvedBinaries.length} config(s) e publicar mesmo assim
              </button>
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="admin-tabs">
        <button className={`admin-tab ${activeTab === 'online' ? 'active' : ''}`} onClick={() => setActiveTab('online')}>
          Online (Thunderstore)
        </button>
        <button className={`admin-tab ${activeTab === 'modpack' ? 'active' : ''}`} onClick={() => setActiveTab('modpack')}>
          Modpack ({modpackMods.length} mods)
        </button>
        <button className={`admin-tab ${activeTab === 'configs' ? 'active' : ''}`} onClick={() => setActiveTab('configs')}>
          Configs ({modpackConfigs.length})
        </button>
      </div>

      {/* ── ONLINE TAB ── */}
      {activeTab === 'online' && (
        <div className="ts-browser-panel">
          <ErrorBoundary>
            <div className="ts-filters">
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Buscar por nome, autor ou descrição..."
                className="ts-search-input"
              />
              <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} className="ts-select">
                <option value="">Todas as categorias</option>
                {availableCategories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)} className="ts-select">
                <option value="downloads">+ Downloads</option>
                <option value="rating">+ Avaliações</option>
                <option value="updated">Mais recentes</option>
                <option value="name">Nome A-Z</option>
              </select>
              <label className="ts-filter-checkbox">
                <input
                  type="checkbox"
                  checked={showDeprecated}
                  onChange={e => setShowDeprecated(e.target.checked)}
                />
                Mostrar depreciados
              </label>
            </div>

            {modsError && (
              <div className="error-banner" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ flex: 1 }}>{modsError}</span>
                <button className="btn-secondary" style={{ fontSize: 13 }} onClick={() => {
                  clearModsCache()
                  setAllMods([])
                  loadMods()
                }}>Tentar novamente</button>
              </div>
            )}

            {loadingMods ? (
              <div className="ts-loading-state">
                <div className="ts-loading-spinner" />
                <p>Carregando mods do Thunderstore...</p>
                <p className="text-muted" style={{ fontSize: 12 }}>Isso pode levar alguns segundos na primeira vez</p>
              </div>
            ) : (
              <>
                <p className="ts-result-count text-muted">
                  {allMods.length === 0
                    ? 'Nenhum mod carregado'
                    : `Mostrando ${Math.min(visibleCount, filteredMods.length)} de ${filteredMods.length} mods${categoryFilter || searchQuery ? ` (${allMods.length} total)` : ''}`
                  }
                </p>
                <div className="ts-mod-list">
                  {visibleMods.map(mod => {
                    const already = modpackMods.some(m => m.source === 'thunderstore' && m.namespace === mod.owner && m.name === mod.name)
                    return (
                      <div
                        key={mod.full_name}
                        className={`ts-mod-item ${already ? 'ts-mod-added' : ''}`}
                        title="Clique para abrir no Thunderstore"
                        onClick={() => mod.package_url && (window as any).Hofheim?.shell?.openExternal(mod.package_url)}
                        style={{ cursor: mod.package_url ? 'pointer' : undefined }}
                      >
                        {mod.latest.icon ? (
                          <img
                            className="ts-mod-icon"
                            src={mod.latest.icon}
                            alt={mod.name}
                            loading="lazy"
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                          />
                        ) : (
                          <div className="ts-mod-icon ts-mod-icon-placeholder" />
                        )}
                        <div className="ts-mod-info">
                          <span className="ts-mod-name">{mod.name}</span>
                          <span className="ts-mod-meta">
                            {mod.owner} · v{mod.latest.version_number} · ↓ {(mod.total_downloads ?? 0).toLocaleString()}
                          </span>
                          <span className="ts-mod-desc">{mod.latest.description?.slice(0, 100)}</span>
                          {(mod.is_deprecated || (mod.categories && mod.categories.length > 0)) && (
                            <div className="ts-mod-badges">
                              {mod.is_deprecated && (
                                <span className="badge badge-warning">Depreciado</span>
                              )}
                              {mod.categories?.slice(0, 2).map(cat => (
                                <span key={cat} className="ts-mod-badge">{cat}</span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="ts-mod-actions" onClick={e => e.stopPropagation()}>
                          {!already && mod.versions.length > 1 && (
                            <select
                              className="version-select-sm"
                              value={selectedVersions[mod.full_name] || mod.latest.version_number}
                              onChange={e => setSelectedVersions(prev => ({ ...prev, [mod.full_name]: e.target.value }))}
                              title="Escolher versão"
                            >
                              {mod.versions.map(v => (
                                <option key={v.version_number} value={v.version_number}>
                                  {v.version_number === mod.latest.version_number ? `${v.version_number} (latest)` : v.version_number}
                                </option>
                              ))}
                            </select>
                          )}
                          <button
                            className={already ? 'btn-ghost' : 'btn-secondary'}
                            style={{ flexShrink: 0, fontSize: 13 }}
                            onClick={() => handleAddThunderstoreMod(mod)}
                            disabled={already}
                          >
                            {already ? '✓ No modpack' : '+ Adicionar'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
                {hasMore && (
                  <div className="ts-load-more">
                    <button className="btn-ghost ts-load-more-btn" onClick={() => setVisibleCount(v => v + PAGE_SIZE)}>
                      Carregar mais {Math.min(PAGE_SIZE, filteredMods.length - visibleCount)} mods
                    </button>
                    <span className="text-muted" style={{ fontSize: 12 }}>
                      {filteredMods.length - visibleCount} restantes
                    </span>
                  </div>
                )}
              </>
            )}

            {/* Config suggestions from scanned mod zips */}
            {(scanningMods.size > 0 || suggestedConfigs.length > 0) && (
              <div className="config-suggestions-area">
                {scanningMods.size > 0 && (
                  <div className="config-scan-notice text-muted">
                    Verificando configs em {Array.from(scanningMods).join(', ')}...
                  </div>
                )}
                {suggestedConfigs.map((suggestion, si) => (
                  <div key={`${suggestion.modName}-${si}`} className="config-suggestion-card">
                    <div className="suggestion-card-header">
                      <span>
                        <strong>{suggestion.modName}</strong> — {suggestion.configs.length} arquivo{suggestion.configs.length > 1 ? 's' : ''} de config encontrado{suggestion.configs.length > 1 ? 's' : ''}
                      </span>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          className="btn-secondary"
                          style={{ fontSize: 12 }}
                          onClick={() => {
                            const toAdd = suggestion.configs
                              .filter(c => !modpackConfigs.some(mc => mc.filename === c.filename))
                              .map(c => ({ mod: suggestion.modName, filename: c.filename, installPath: c.installPath, content: c.content }))
                            if (toAdd.length > 0) setModpackConfigs(prev => [...prev, ...toAdd])
                            setSuggestedConfigs(prev => prev.filter((_, i) => i !== si))
                          }}
                        >
                          + Adicionar todos
                        </button>
                        <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setSuggestedConfigs(prev => prev.filter((_, i) => i !== si))}>
                          Ignorar
                        </button>
                      </div>
                    </div>
                    <div className="suggestion-file-list">
                      {suggestion.configs.map((cfg, ci) => {
                        const alreadyAdded = modpackConfigs.some(mc => mc.filename === cfg.filename)
                        return (
                          <div key={cfg.filename} className="suggestion-file-item">
                            <span className="suggestion-filename">{cfg.filename}</span>
                            <span className="text-muted" style={{ fontSize: 11, flex: 1 }}>{cfg.installPath}</span>
                            {alreadyAdded ? (
                              <span className="text-muted" style={{ fontSize: 12 }}>✓ já adicionado</span>
                            ) : (
                              <button
                                className="btn-ghost"
                                style={{ fontSize: 12 }}
                                onClick={() => {
                                  setModpackConfigs(prev => [...prev, { mod: suggestion.modName, filename: cfg.filename, installPath: cfg.installPath, content: cfg.content }])
                                  setSuggestedConfigs(prev => prev.map((s, i) => i === si
                                    ? { ...s, configs: s.configs.filter((_, j) => j !== ci) }
                                    : s
                                  ).filter(s => s.configs.length > 0))
                                }}
                              >
                                + Adicionar
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ErrorBoundary>
        </div>
      )}

      {/* ── MODPACK TAB ── */}
      {activeTab === 'modpack' && (
        <>
          {/* Pack metadata */}
          <div className="admin-section card">
            <div className="card-header"><h3>Informações do Modpack</h3></div>
            <div className="card-body">
              <div className="form-group">
                <label>Modpack</label>
                <select
                  value={target}
                  onChange={e => {
                    const t = e.target.value as Target
                    // Save current state before switching — draft sync effect also handles this
                    // but we want it captured synchronously before the target state flip
                    drafts.current[target] = {
                      name: packName,
                      description: packDescription,
                      version: packVersion,
                      mods: modpackMods,
                      configs: modpackConfigs,
                      battlemetricsId: packBattlemetricsId,
                    }
                    setTarget(t)
                  }}
                >
                  <option value="main">Hofheim Mundo 1 (servidor público)</option>
                  <option value="main2">Hofheim Mundo 2 (servidor público)</option>
                  <option value="admin">Hofheim Admin (secreto)</option>
                </select>
                <span className="form-hint">
                  Cada mundo é um servidor com mods e configs próprios (o IP fica na config de um
                  mod). O jogador escolhe o mundo direto na barra lateral do launcher.
                </span>
              </div>

              {/* Atalho para montar um mundo novo a partir do que já está no ar no Mundo 1. */}
              {target !== 'main' && (
                <div className="form-group">
                  <label>Começar a partir do Mundo 1</label>
                  {!confirmCopy ? (
                    <button className="btn-ghost" style={{ fontSize: 13, alignSelf: 'flex-start' }}
                      onClick={() => setConfirmCopy(true)} disabled={copyingWorld1}>
                      ⧉ Copiar mods e configs do Mundo 1
                    </button>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span className="text-secondary" style={{ fontSize: 13 }}>
                        Substituir os {modpackMods.length} mod(s) e {modpackConfigs.length} config(s) deste
                        modpack pelos do Mundo 1?
                      </span>
                      <button className="btn-secondary" style={{ fontSize: 13 }}
                        onClick={handleCopyFromWorld1} disabled={copyingWorld1}>
                        {copyingWorld1 ? 'Copiando...' : 'Copiar'}
                      </button>
                      <button className="btn-ghost" style={{ fontSize: 13 }}
                        onClick={() => setConfirmCopy(false)} disabled={copyingWorld1}>
                        Cancelar
                      </button>
                    </div>
                  )}
                  <span className="form-hint">
                    Traz a lista atual do Mundo 1 para cá (o nome, a descrição e a versão deste modpack
                    são mantidos). Nada é publicado até você clicar em Publicar.
                  </span>
                </div>
              )}
              <div className="form-group">
                <label>Descrição</label>
                <input type="text" value={packDescription} onChange={e => setPackDescription(e.target.value)} />
              </div>
              <div className="form-group">
                <label>Versão</label>
                <input type="text" value={packVersion} onChange={e => setPackVersion(e.target.value)} style={{ width: '150px' }} />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>BattleMetrics ID do Servidor</label>
                <input
                  type="text"
                  value={packBattlemetricsId}
                  onChange={e => setPackBattlemetricsId(e.target.value)}
                  placeholder="ex: 12345678"
                  style={{ width: '200px' }}
                />
                <span className="form-hint">
                  Opcional, só referência. O status e os jogadores da home vêm da consulta direta ao
                  IP do servidor (configurado no Painel Admin), não do BattleMetrics.
                </span>
              </div>
            </div>
          </div>

          {/* Import / Export */}
          <div className="admin-section card">
            <div className="card-header">
              <h3>Importar / Exportar</h3>
              <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => { setShowImportExport(v => !v); setExportCode(''); setImportError('') }}>
                {showImportExport ? 'Fechar ▲' : 'Abrir ▼'}
              </button>
            </div>
            {showImportExport && (
              <div className="card-body">
                {/* Export */}
                <div style={{ marginBottom: 16 }}>
                  <p className="text-muted" style={{ fontSize: 12, marginBottom: 8 }}>
                    Exporta o modpack atual para compartilhar ou fazer backup.
                  </p>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn-secondary" style={{ fontSize: 13 }} onClick={handleExportCode}>
                      Gerar código
                    </button>
                    <button className="btn-ghost" style={{ fontSize: 13 }} onClick={handleExportFile}>
                      Salvar arquivo (.Hofheim)
                    </button>
                  </div>
                  {exportCode && (
                    <div style={{ marginTop: 10 }}>
                      <textarea
                        readOnly
                        value={exportCode}
                        rows={3}
                        className="cfg-edit-textarea"
                        style={{ width: '100%', fontSize: 11, fontFamily: 'monospace', resize: 'none' }}
                        onFocus={e => e.target.select()}
                      />
                      <button
                        className="btn-ghost"
                        style={{ fontSize: 12, marginTop: 6 }}
                        onClick={() => {
                          navigator.clipboard.writeText(exportCode).catch(() => {})
                          setCodeCopied(true)
                          setTimeout(() => setCodeCopied(false), 2000)
                        }}
                      >
                        {codeCopied ? '✓ Copiado!' : 'Copiar código'}
                      </button>
                    </div>
                  )}
                </div>

                {/* Divider */}
                <div style={{ borderTop: '1px solid var(--border-color)', marginBottom: 16 }} />

                {/* Import */}
                <p className="text-muted" style={{ fontSize: 12, marginBottom: 8 }}>
                  Importar sobrescreve o modpack atual com os dados do código ou arquivo.
                </p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <textarea
                      value={importCodeInput}
                      onChange={e => setImportCodeInput(e.target.value)}
                      placeholder="Cole o código Hofheim-v1-… ou o código de perfil do R2ModManager"
                      rows={3}
                      className="cfg-edit-textarea"
                      style={{ width: '100%', fontSize: 11, fontFamily: 'monospace', resize: 'none' }}
                    />
                    <button
                      className="btn-secondary"
                      style={{ fontSize: 13, marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 8 }}
                      onClick={handleImportCode}
                      disabled={!importCodeInput.trim() || !!importing}
                    >
                      {importing === 'code' && <span className="ts-loading-spinner" style={{ width: 13, height: 13, borderWidth: 2 }} />}
                      {importing === 'code' ? 'Importando…' : 'Importar por código'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 2 }}>
                    <button
                      className="btn-ghost"
                      style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 8 }}
                      onClick={handleImportFile}
                      disabled={!!importing}
                    >
                      {importing === 'file' && <span className="ts-loading-spinner" style={{ width: 13, height: 13, borderWidth: 2 }} />}
                      {importing === 'file' ? 'Importando…' : 'Importar arquivo (.Hofheim / .json)'}
                    </button>
                    <button
                      className="btn-ghost"
                      style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 8 }}
                      onClick={handleImportR2File}
                      disabled={!!importing}
                    >
                      {importing === 'r2' && <span className="ts-loading-spinner" style={{ width: 13, height: 13, borderWidth: 2 }} />}
                      {importing === 'r2' ? 'Importando…' : 'Importar perfil do R2ModManager (.r2z)'}
                    </button>
                  </div>
                </div>
                {importError && <p className="text-error" style={{ fontSize: 12, marginTop: 8 }}>{importError}</p>}
                {importSuccess && <p style={{ fontSize: 12, marginTop: 8, color: 'var(--accent-green)' }}>{importSuccess}</p>}
              </div>
            )}
          </div>

          {/* Current modpack mods */}
          <div className="admin-section card">
            <div className="card-header">
              <h3>Mods do Modpack ({modpackMods.length})</h3>
              <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setActiveTab('online')}>
                + Adicionar mods
              </button>
            </div>
            <div className="card-body">
              {modpackMods.length === 0 ? (
                <p className="text-muted">
                  Nenhum mod adicionado.{' '}
                  <button className="btn-link" onClick={() => setActiveTab('online')}>
                    Ir para a aba Online
                  </button>{' '}
                  para adicionar mods do Thunderstore.
                </p>
              ) : (
                <>
                  <input
                    type="text"
                    value={modpackFilter}
                    onChange={e => setModpackFilter(e.target.value)}
                    placeholder="Buscar mod no modpack por nome ou autor..."
                    className="ts-search-input"
                    style={{ marginBottom: 12 }}
                  />
                  {modpackFilter.trim() && (
                    <p className="text-muted" style={{ fontSize: 12, marginBottom: 8 }}>
                      {visibleModpackMods.length} de {modpackMods.length} mods
                    </p>
                  )}
                  {visibleModpackMods.length === 0 ? (
                    <p className="text-muted">Nenhum mod corresponde à busca.</p>
                  ) : (
                <div className="modpack-mods">
                  {visibleModpackMods.map(({ mod, index }) => {
                    const icon = modIconFor(mod)
                    return (
                    <div key={`${mod.name}-${index}`} className="modpack-mod-item">
                      <div className="mod-info">
                        {icon ? (
                          <img
                            className="ts-mod-icon modpack-mod-icon"
                            src={icon}
                            alt={mod.name}
                            loading="lazy"
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                          />
                        ) : (
                          <div className="ts-mod-icon ts-mod-icon-placeholder modpack-mod-icon" />
                        )}
                        <span className="mod-name">
                          {mod.name}{' '}
                          <span className={`badge ${mod.source === 'private' ? 'badge-warning' : 'badge-update'}`}>
                            {mod.source === 'private' ? 'privado' : 'thunderstore'}
                          </span>
                        </span>
                        {mod.source === 'thunderstore' ? (() => {
                          const tsVersions = allMods.find(m => m.name === mod.name && m.owner === mod.namespace)?.versions ?? []
                          return tsVersions.length > 1 ? (
                            <select
                              className="version-select-sm"
                              value={mod.version || ''}
                              onChange={e => handleUpdateModVersion(index, e.target.value)}
                              title="Versão pinada"
                            >
                              {tsVersions.map(v => (
                                <option key={v.version_number} value={v.version_number}>
                                  {v.version_number}
                                </option>
                              ))}
                              {/* Ensure current version is always an option even if allMods is stale */}
                              {mod.version && !tsVersions.some(v => v.version_number === mod.version) && (
                                <option value={mod.version}>{mod.version}</option>
                              )}
                            </select>
                          ) : (
                            <input type="text" value={mod.version || ''} className="version-input"
                              onChange={e => handleUpdateModVersion(index, e.target.value)} />
                          )
                        })() : (
                          <span className="text-muted">{mod.filename}</span>
                        )}
                      </div>
                      <label className="mod-optional-toggle" title="Jogadores poderão escolher não instalar esse mod">
                        <input
                          type="checkbox"
                          checked={!!mod.optional}
                          onChange={() => handleToggleOptional(index)}
                        />
                        Opcional
                      </label>
                      <button className="btn-ghost btn-remove" onClick={() => handleRemoveMod(index)}>Remover</button>
                    </div>
                    )
                  })}
                </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Private mods */}
          <div className="admin-section card">
            <div className="card-header">
              <h3>Mods Privados</h3>
              <button
                className="btn-ghost"
                style={{ fontSize: 12 }}
                onClick={loadRepoMods}
                disabled={repoLoading}
              >
                {repoLoading ? 'Carregando...' : '↻ Listar do repo'}
              </button>
            </div>
            <div className="card-body">

              {/* Upload new file */}
              <div className="priv-upload-area">
                <div className="priv-upload-row">
                  <button className="btn-ghost priv-pick-btn" onClick={handlePickFile}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="17,8 12,3 7,8"/>
                      <line x1="12" y1="3" x2="12" y2="15"/>
                    </svg>
                    Selecionar arquivo (.zip / .dll / .mdb)
                  </button>
                  {pendingFile && (
                    <span className="priv-file-preview">
                      <strong>{pendingFile.filename}</strong>
                      <span className="text-muted"> ({pendingFile.size >= 1024 * 1024
                        ? `${(pendingFile.size / 1024 / 1024).toFixed(1)} MB`
                        : `${(pendingFile.size / 1024).toFixed(0)} KB`})</span>
                    </span>
                  )}
                </div>

                {pendingFile && (
                  <div className="priv-upload-form">
                    <input
                      type="text"
                      value={privName}
                      onChange={e => setPrivName(e.target.value)}
                      placeholder="Nome do mod (ex: MeuPlugin)"
                      style={{ flex: 1 }}
                    />
                    <button
                      className="btn-secondary"
                      onClick={handleUploadAndAdd}
                      disabled={uploading || !privName.trim()}
                    >
                      {uploading ? `Enviando... ${uploadProgress}%` : '↑ Upload e Adicionar'}
                    </button>
                    {!uploading && (
                      <button className="btn-ghost" onClick={() => { setPendingFile(null); setPrivName(''); setPrivFilename('') }}>
                        ✕
                      </button>
                    )}
                  </div>
                )}
                {uploading && (
                  <div style={{ height: 4, background: 'var(--border-color)', borderRadius: 2, marginTop: 8, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${uploadProgress}%`, background: 'var(--accent-green)', transition: 'width 0.2s' }} />
                  </div>
                )}
                {uploadError && <p className="text-error" style={{ marginTop: 8, fontSize: 12 }}>{uploadError}</p>}
              </div>

              {/* Existing mods in repo */}
              {repoError && <p className="text-error" style={{ fontSize: 12, marginBottom: 8 }}>{repoError}</p>}
              {repoMods.length > 0 && (
                <div className="priv-repo-list">
                  <p className="text-muted" style={{ fontSize: 12, marginBottom: 8 }}>Arquivos disponíveis no repo:</p>
                  {repoMods.map(entry => {
                    const inPack = modpackMods.some(m => m.source === 'private' && m.filename === entry.filename)
                    return (
                      <div key={entry.filename} className="priv-repo-item">
                        <div className="priv-repo-info">
                          <span className="priv-repo-filename">{entry.filename}</span>
                          <span className="text-muted" style={{ fontSize: 11 }}>
                            {(entry.size / 1024).toFixed(0)} KB · {new Date(entry.updatedAt).toLocaleDateString('pt-BR')}
                          </span>
                        </div>
                        {inPack ? (
                          <span className="text-muted" style={{ fontSize: 12 }}>✓ no modpack</span>
                        ) : (
                          <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => handleAddFromRepo(entry)}>
                            + Adicionar
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              {repoMods.length === 0 && !repoLoading && !repoError && (
                <p className="text-muted" style={{ fontSize: 12 }}>
                  Clique em "↻ Listar do repo" para ver os arquivos já disponíveis.
                </p>
              )}
            </div>
          </div>

          <div className="admin-actions">
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <button className="btn-play" style={{ width: 'auto', padding: '12px 32px' }}
                onClick={handlePublish} disabled={publishing}>
                {publishing ? 'Publicando...' : saved ? 'Publicado!' : `Publicar (${TARGET_LABELS[target]})`}
              </button>
              {publishProgressBar}
            </div>
          </div>
        </>
      )}

      {/* ── CONFIGS TAB ── */}
      {activeTab === 'configs' && (
        <>
          {/* Pacote .zip (texturas e afins) — sobe pro R2 e é extraído no perfil do player */}
          <div className="admin-section card">
            <div className="card-header"><h3>Pacote de Configs (.zip)</h3></div>
            <div className="card-body">
              <p className="text-muted" style={{ fontSize: 12, marginTop: 0 }}>
                Para conjuntos de arquivos — ex.: pacote de texturas. O .zip vai pro bucket R2 (em
                partes, aguenta centenas de MB) e o modpack guarda só a URL. Na instalação o launcher
                baixa e <strong>extrai o conteúdo</strong> na pasta destino do perfil, preservando as
                subpastas do zip. O .zip não fica no perfil do player.
              </p>

              <div className="form-group">
                <label>Pasta destino no perfil</label>
                <input
                  type="text"
                  value={zipDest}
                  onChange={e => setZipDest(e.target.value)}
                  placeholder="BepInEx/config"
                  style={{ fontFamily: 'monospace', fontSize: 12 }}
                  disabled={zipUploading}
                />
                <span className="form-hint">
                  Relativo ao perfil. O conteúdo do zip é extraído aqui — ex.: um zip com{' '}
                  <code>CustomTextures/armor.png</code> e destino <code>BepInEx/config</code> vira{' '}
                  <code>BepInEx/config/CustomTextures/armor.png</code>.
                </span>
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn-ghost" style={{ fontSize: 13 }} onClick={handlePickConfigZip} disabled={zipUploading}>
                  {zipPick ? '↻ Trocar arquivo' : '📦 Selecionar .zip'}
                </button>
                {zipPick && (
                  <>
                    <span style={{ fontSize: 12 }}>
                      <strong>{zipPick.filename}</strong>{' '}
                      <span className="text-muted">
                        ({(zipPick.size / 1024 / 1024).toFixed(1)} MB · {zipPick.entries} arquivo{zipPick.entries === 1 ? '' : 's'})
                      </span>
                    </span>
                    <button
                      className="btn-secondary"
                      style={{ fontSize: 13 }}
                      onClick={handleUploadConfigZip}
                      disabled={zipUploading || !adminToken}
                    >
                      {zipUploading ? `Enviando... ${zipProgress}%` : '↑ Enviar e adicionar ao modpack'}
                    </button>
                    {!zipUploading && (
                      <button className="btn-ghost" onClick={() => { setZipPick(null); setZipError('') }}>✕</button>
                    )}
                  </>
                )}
              </div>

              {zipUploading && (
                <div style={{ height: 4, background: 'var(--border-color)', borderRadius: 2, marginTop: 8, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${zipProgress}%`, background: 'var(--accent-green)', transition: 'width 0.2s' }} />
                </div>
              )}
              {zipError && <p className="text-error" style={{ marginTop: 8, fontSize: 12 }}>{zipError}</p>}
              {!adminToken && (
                <p className="text-muted" style={{ marginTop: 8, fontSize: 12 }}>
                  Faça login de admin para enviar pacotes.
                </p>
              )}
            </div>
          </div>

          {/* Local profile config reader */}
          <div className="admin-section card">
            <div className="card-header"><h3>Configs do Perfil Local</h3></div>
            <div className="card-body">
              {/* Arrastar a pasta `config` aqui equivale a escolhê-la no diálogo: o main libera
                  a pasta (só aceita nome `config`) e a listagem roda na hora. */}
              <div
                className="form-group"
                onDragOver={e => {
                  e.preventDefault()
                  // Sem dropEffect explícito o cursor pode aparecer como "não pode soltar aqui".
                  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
                  setLocalDirDragOver(true)
                }}
                onDragLeave={() => setLocalDirDragOver(false)}
                onDrop={handleDropLocalDir}
                style={{
                  border: `1px dashed ${localDirDragOver ? 'var(--color-primary, #4a9eda)' : 'transparent'}`,
                  borderRadius: 6,
                  padding: localDirDragOver ? 8 : 0,
                  transition: 'padding 80ms',
                }}
              >
                <label>Pasta BepInEx/config (r2modman)</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={localConfigDir}
                    onChange={e => setLocalConfigDir(e.target.value)}
                    placeholder="C:\Users\...\BepInEx\config"
                    style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                    onKeyDown={e => e.key === 'Enter' && handleListLocalConfigs()}
                  />
                  <button className="btn-ghost" style={{ fontSize: 13, whiteSpace: 'nowrap' }} onClick={handlePickLocalDir}>
                    Buscar...
                  </button>
                  <button className="btn-secondary" style={{ fontSize: 13, whiteSpace: 'nowrap' }} onClick={handleListLocalConfigs} disabled={!localConfigDir.trim() || localConfigLoading}>
                    {localConfigLoading ? 'Listando...' : 'Listar'}
                  </button>
                </div>
                <p className="text-muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 0 }}>
                  {localDirDragOver
                    ? 'Solte a pasta config aqui'
                    : 'Ou arraste a pasta config (a que fica dentro de BepInEx) para cá.'}
                </p>
              </div>

              {localConfigError && <p className="text-muted" style={{ color: 'var(--color-error, #e55)', fontSize: 13 }}>{localConfigError}</p>}

              {/* Espelhar a pasta inteira: o installPath de cada config sai da posição do
                  arquivo na pasta, então a estrutura de subpastas é replicada igual no player. */}
              {localConfigFiles.length > 0 && (
                <div className="form-group" style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--color-border, #2a3a4a)' }}>
                  <label>Espelhar esta pasta no modpack</label>
                  <p className="text-muted" style={{ fontSize: 11, marginBottom: 6 }}>
                    Deixa a lista de configs do modpack IGUAL a esta pasta: cada arquivo entra no caminho
                    onde ele está aqui (<code>Icons/x.png</code> → <code>BepInEx/config/Icons/x.png</code>),
                    o que mudou é atualizado e o que não existe mais aqui é removido. Limpe a pasta antes —
                    o que estiver errado nela vai para todos os jogadores.
                  </p>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      className="btn-secondary"
                      style={{ fontSize: 12 }}
                      onClick={handlePlanMirror}
                      disabled={mirrorRunning}
                    >
                      {mirrorRunning && !mirrorPlan
                        ? `Comparando... ${mirrorProgress.done}/${mirrorProgress.total}`
                        : 'Comparar pasta com o modpack'}
                    </button>
                    {mirrorPlan && (
                      <>
                        <button
                          className="btn-primary"
                          style={{ fontSize: 12 }}
                          onClick={handleApplyMirror}
                          disabled={mirrorRunning || (
                            mirrorPlan.toAdd.length + mirrorPlan.toUpdate.length + mirrorPlan.toRemove.length === 0
                          )}
                        >
                          {mirrorRunning
                            ? `Aplicando... ${mirrorProgress.done}/${mirrorProgress.total}`
                            : 'Aplicar espelhamento'}
                        </button>
                        <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setMirrorPlan(null)} disabled={mirrorRunning}>
                          Cancelar
                        </button>
                      </>
                    )}
                  </div>

                  {mirrorError && (
                    <p style={{ color: 'var(--color-error, #e55)', fontSize: 12, marginTop: 6 }}>{mirrorError}</p>
                  )}
                  {mirrorResult && !mirrorPlan && (
                    <p className="text-muted" style={{ fontSize: 12, marginTop: 6 }}>{mirrorResult}</p>
                  )}

                  {mirrorPlan && (
                    <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.7 }}>
                      <div>
                        <strong>{mirrorPlan.toAdd.length}</strong> a adicionar ·{' '}
                        <strong>{mirrorPlan.toUpdate.length}</strong> a atualizar ·{' '}
                        <strong style={{ color: mirrorPlan.toRemove.length ? 'var(--color-error, #e55)' : undefined }}>
                          {mirrorPlan.toRemove.length}
                        </strong>{' '}
                        a remover · {mirrorPlan.unchanged} sem mudança
                      </div>
                      {(mirrorPlan.keptExtract > 0 || mirrorPlan.keptOutside > 0) && (
                        <div className="text-muted">
                          Preservados sem análise: {mirrorPlan.keptExtract} pacote(s) .zip
                          {mirrorPlan.keptOutside > 0 && ` · ${mirrorPlan.keptOutside} config(s) fora de BepInEx/config/`}
                        </div>
                      )}
                      {(mirrorPlan.skippedZip.length > 0 || mirrorPlan.skippedEmpty.length > 0 || mirrorPlan.skippedUnknownExt.length > 0) && (
                        <div className="text-muted">
                          Fora do espelho: {mirrorPlan.skippedZip.length} .zip solto(s)
                          {' · '}{mirrorPlan.skippedEmpty.length} vazio(s)
                          {' · '}{mirrorPlan.skippedUnknownExt.length} extensão não reconhecida
                          {' '}(nenhum deles é removido do modpack)
                        </div>
                      )}
                      {mirrorPlan.toRemove.length > 0 && (
                        <details style={{ marginTop: 4 }}>
                          <summary style={{ cursor: 'pointer' }}>
                            Ver os {mirrorPlan.toRemove.length} que serão removidos
                          </summary>
                          <div style={{ maxHeight: 160, overflowY: 'auto', fontFamily: 'monospace', fontSize: 11, marginTop: 4 }}>
                            {mirrorPlan.toRemove.map(p => <div key={p}>{p}</div>)}
                          </div>
                        </details>
                      )}
                      {mirrorPlan.toAdd.length + mirrorPlan.toUpdate.length + mirrorPlan.toRemove.length === 0 && (
                        <div className="text-muted">O modpack já está igual à pasta — nada a fazer.</div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {localConfigFiles.length > 0 && (
                <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                  {/* File list */}
                  <div style={{ width: 220, flexShrink: 0 }}>
                    <p className="text-muted" style={{ fontSize: 11, marginBottom: 4 }}>{localConfigFiles.length} arquivo{localConfigFiles.length > 1 ? 's' : ''}</p>
                    {localPendingCount > 0 && (
                      <button
                        className="btn-secondary"
                        style={{ fontSize: 12, width: '100%', marginBottom: 6 }}
                        onClick={handleAddAllLocalToModpack}
                        disabled={localAddAllRunning}
                      >
                        {localAddAllRunning
                          ? `Adicionando... ${localAddAllProgress.done}/${localAddAllProgress.total}`
                          : `+ Adicionar tudo (${localPendingCount})`}
                      </button>
                    )}
                    {localAddAllResult && (
                      <p className="text-muted" style={{ fontSize: 11, marginBottom: 6 }}>{localAddAllResult}</p>
                    )}
                    <div className="cfg-file-list" style={{ maxHeight: 320, overflowY: 'auto' }}>
                      {localConfigFiles.map(f => {
                        const inModpack = modpackConfigs.some(c => c.filename === f)
                        return (
                          <button
                            key={f}
                            type="button"
                            className={`cfg-file-option ${localSelectedFile === f ? 'active' : ''}`}
                            onClick={() => handleOpenLocalFile(f)}
                            style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}
                          >
                            <span className="cfg-file-name">{f}</span>
                            <span
                              className={inModpack ? 'cfg-file-status-in' : 'cfg-file-status-out'}
                              style={{ fontSize: 10 }}
                            >
                              {inModpack ? '✓ no modpack' : '✕ não está no modpack'}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Editor pane */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {localFileLoading && <p className="text-muted" style={{ fontSize: 13 }}>Carregando...</p>}
                    {!localFileLoading && localSelectedFile && (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>{localSelectedFile}</span>
                          <div style={{ display: 'flex', gap: 8 }}>
                            {isBinaryConfigPath(localSelectedFile) ? (
                              // Binário: sempre permite (re)enviar pro R2 — inclusive pra corrigir
                              // um asset antes corrompido. Não há edição de texto nem "salvar no disco".
                              <button
                                className="btn-ghost"
                                style={{ fontSize: 12 }}
                                onClick={handleAddLocalToModpack}
                                disabled={localUploading}
                              >
                                {localUploading
                                  ? 'Enviando ao R2...'
                                  : modpackConfigs.some(c => c.filename === localSelectedFile)
                                    ? '↻ Reenviar ao R2'
                                    : '+ Enviar binário ao R2'}
                              </button>
                            ) : (
                              <>
                                <button
                                  className="btn-ghost"
                                  style={{ fontSize: 12 }}
                                  onClick={handleAddLocalToModpack}
                                  disabled={modpackConfigs.some(c => c.filename === localSelectedFile)}
                                >
                                  {modpackConfigs.some(c => c.filename === localSelectedFile) ? '✓ No modpack' : '+ Adicionar ao modpack'}
                                </button>
                                <button className="btn-secondary" style={{ fontSize: 12 }} onClick={handleSaveLocalFile} disabled={localFileSaving}>
                                  {localFileSaved ? 'Salvo!' : localFileSaving ? 'Salvando...' : 'Salvar no disco'}
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                        {localUploadError && <p className="text-error" style={{ fontSize: 12, marginBottom: 6 }}>{localUploadError}</p>}
                        {isBinaryConfigPath(localSelectedFile) ? (
                          <>
                            <p className="text-muted" style={{ fontSize: 12, padding: '12px 0 0' }}>
                              Arquivo binário — não é editável como texto. Ele será enviado ao bucket R2
                              e o modpack guardará a URL; os players baixam os bytes originais na instalação.
                            </p>
                            {/* .zip por aqui vai como ARQUIVO (sem extrair) e em base64 — o card do topo
                                é o caminho certo pra pacote de texturas. */}
                            {/\.zip$/i.test(localSelectedFile) && (
                              <p className="text-muted" style={{ fontSize: 12, padding: '8px 0 12px' }}>
                                ⚠ Por aqui o .zip vira <strong>um arquivo</strong> no perfil
                                (<code>{`BepInEx/config/${localSelectedFile}`}</code>) e o envio carrega o
                                arquivo inteiro na memória. Para pacote de texturas use o card{' '}
                                <strong>“Pacote de Configs (.zip)”</strong> no topo: sobe em partes e o
                                launcher <strong>extrai</strong> o conteúdo no perfil do player.
                              </p>
                            )}
                          </>
                        ) : (
                          <textarea
                            className="cfg-edit-textarea"
                            value={localFileContent}
                            onChange={e => setLocalFileContent(e.target.value)}
                            rows={16}
                            spellCheck={false}
                            style={{ width: '100%' }}
                          />
                        )}
                      </>
                    )}
                    {!localFileLoading && !localSelectedFile && (
                      <p className="text-muted" style={{ fontSize: 13, paddingTop: 8 }}>Selecione um arquivo à esquerda para editar.</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="admin-section card">
            <div className="card-header"><h3>Adicionar Config</h3></div>
            <div className="card-body">
              <div className="form-group">
                <label>Mod relacionado</label>
                <select
                  value={cfgMod}
                  onChange={e => {
                    setCfgMod(e.target.value)
                    setCfgFilename('')
                    setCfgInstallPath('')
                    setCfgContent('')
                  }}
                >
                  <option value="">— selecione —</option>
                  {modpackMods.map((m, i) => <option key={i} value={m.name}>{m.name}</option>)}
                </select>
              </div>

              {/* Config files discovered from the mod's zip */}
              {cfgMod && (
                <div className="cfg-file-picker form-group">
                  <label>Arquivo de config</label>
                  {cfgScanLoading && (
                    <p className="text-muted" style={{ fontSize: 12, margin: '6px 0' }}>
                      Verificando arquivos de config do mod...
                    </p>
                  )}
                  {!cfgScanLoading && cfgDiscoveredFiles.length > 0 && (
                    <div className="cfg-file-list">
                      {cfgDiscoveredFiles.map(f => (
                        <button
                          key={f.filename}
                          type="button"
                          className={`cfg-file-option ${cfgFilename === f.filename ? 'active' : ''}`}
                          onClick={() => {
                            setCfgFilename(f.filename)
                            setCfgInstallPath(f.installPath)
                            setCfgContent(f.content)
                          }}
                        >
                          <span className="cfg-file-name">{f.filename}</span>
                          <span className="cfg-file-path text-muted">{f.installPath}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {!cfgScanLoading && cfgDiscoveredFiles.length === 0 && cfgMod && (
                    <p className="text-muted" style={{ fontSize: 12, margin: '6px 0' }}>
                      {modpackMods.find(m => m.name === cfgMod)?.source === 'private'
                        ? 'Mods privados: insira o nome do arquivo manualmente abaixo.'
                        : 'Nenhum arquivo .cfg encontrado no zip. Insira manualmente.'}
                    </p>
                  )}
                  {/* Always allow manual override */}
                  <input
                    type="text"
                    value={cfgFilename}
                    onChange={e => setCfgFilename(e.target.value)}
                    placeholder="ou digite o nome do arquivo..."
                    style={{ marginTop: cfgDiscoveredFiles.length > 0 ? 8 : 0 }}
                  />
                </div>
              )}

              {cfgFilename && (
                <>
                  <div className="form-group">
                    <label>Caminho de instalação</label>
                    <input type="text" value={cfgInstallPath} onChange={e => setCfgInstallPath(e.target.value)} placeholder="BepInEx/config/valheim_plus.cfg" />
                    <span className="form-hint">Relativo ao perfil. Vazio = BepInEx/config/&lt;arquivo&gt;.</span>
                  </div>
                  <div className="form-group">
                    <label>Conteúdo</label>
                    <textarea
                      value={cfgContent}
                      onChange={e => setCfgContent(e.target.value)}
                      rows={8}
                      className="cfg-edit-textarea"
                      spellCheck={false}
                      placeholder="# Conteúdo do arquivo, ou uma URL https:// para buscar na instalação"
                    />
                  </div>
                </>
              )}

              <button className="btn-secondary" onClick={handleAddConfig} disabled={!cfgFilename.trim() || !cfgMod}>
                + Adicionar Config
              </button>
            </div>
          </div>

          <div className="admin-section card">
            <div className="card-header"><h3>Configs do Modpack ({modpackConfigs.length})</h3></div>
            <div className="card-body">
              {modpackConfigs.length === 0 ? (
                <p className="text-muted">Nenhuma config adicionada.</p>
              ) : (
                <div className="modpack-mods">
                  {modpackConfigs.map((cfg, index) => {
                    const isEditing = editingConfigIndex === index
                    return (
                      <div key={`${cfg.filename}-${index}`} className={`modpack-mod-item cfg-item ${isEditing ? 'cfg-item-expanded' : ''}`}>
                        <div className="cfg-item-header">
                          <div className="mod-info">
                            <span className="mod-name">
                              {cfg.filename}
                              {cfg.extract && (
                                <span className="text-muted" style={{ fontSize: 11, marginLeft: 6 }}>📦 zip extraído</span>
                              )}
                            </span>
                            <span className="text-muted">
                              {cfg.extract ? `extrai em ${cfg.installPath}/` : cfg.installPath}{cfg.mod ? ` · ${cfg.mod}` : ''}
                            </span>
                          </div>
                          <div className="cfg-item-actions">
                            <button
                              className="btn-ghost"
                              style={{ fontSize: 12 }}
                              onClick={() => {
                                if (isEditing) {
                                  setEditingConfigIndex(null)
                                } else {
                                  setEditingConfigIndex(index)
                                  setEditingContent(cfg.content)
                                }
                              }}
                            >
                              {isEditing ? 'Fechar' : cfg.extract ? 'Ver URL' : 'Editar'}
                            </button>
                            <button className="btn-ghost btn-remove" onClick={() => {
                              handleRemoveConfig(index)
                              if (editingConfigIndex === index) setEditingConfigIndex(null)
                            }}>Remover</button>
                          </div>
                        </div>
                        {isEditing && (
                          <div className="cfg-edit-area">
                            <textarea
                              className="cfg-edit-textarea"
                              value={editingContent}
                              onChange={e => setEditingContent(e.target.value)}
                              rows={12}
                              spellCheck={false}
                              placeholder="Conteúdo do arquivo, ou uma URL https:// para buscar no momento da instalação"
                            />
                            <div className="cfg-edit-footer">
                              <span className="text-muted" style={{ fontSize: 11 }}>
                                {editingContent.startsWith('http') ? '🔗 URL — conteúdo será buscado na instalação' : `${editingContent.length} chars`}
                              </span>
                              <div style={{ display: 'flex', gap: 8 }}>
                                <button
                                  className="btn-secondary"
                                  style={{ fontSize: 13 }}
                                  onClick={() => {
                                    setModpackConfigs(modpackConfigs.map((c, i) => i === index ? { ...c, content: editingContent } : c))
                                    setEditingConfigIndex(null)
                                  }}
                                >
                                  Salvar
                                </button>
                                <button className="btn-ghost" style={{ fontSize: 13 }} onClick={() => setEditingConfigIndex(null)}>
                                  Cancelar
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="admin-actions">
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <button className="btn-play" style={{ width: 'auto', padding: '12px 32px' }}
                onClick={handlePublish} disabled={publishing}>
                {publishing ? 'Publicando...' : saved ? 'Publicado!' : `Publicar (${TARGET_LABELS[target]})`}
              </button>
              {publishProgressBar}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
