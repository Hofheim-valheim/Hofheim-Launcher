import { NewsItem } from '../components/News/NewsCard'

export interface User {
  username: string
  role: 'player' | 'admin'
}

/** Payload publicado/lido de {backendUrl}/news — home page + aviso fixado + notícias + status. */
export interface NewsData {
  featured?: {
    title: string
    subtitle?: string
    image?: string
    link?: string
    cta?: string
  }
  pinnedAlert?: { text: string; link?: string }
  news: NewsItem[]
  serverInfo?: { ip?: string; uptime?: string; version?: string }
}

export type ModSource = 'thunderstore' | 'private'

export interface Mod {
  name: string
  source: ModSource
  /** Thunderstore namespace/owner (source: 'thunderstore') */
  namespace?: string
  version?: string
  /** Nome do arquivo do mod privado (source: 'private') */
  filename?: string
  /**
   * URL de download. Para thunderstore é a URL absoluta do pacote.
   * Para privados é um caminho relativo resolvido pelo backend (ex: /mods/private/Foo.zip).
   */
  downloadUrl: string
  /** Hash SHA-256 (hex) do arquivo baixado. Quando presente, o download é verificado. Opcional. */
  sha256?: string
  description?: string
  /** Se true, o jogador pode escolher não instalar esse mod (ver ModsView). */
  optional?: boolean
  // runtime
  installed?: boolean
  outdated?: boolean
  /** true quando é opcional e o jogador desativou. Calculado em checkOutdated. */
  optionalDisabled?: boolean
}

/**
 * Status do auto-updater. `not-available` = a checagem rodou e você já está na última versão —
 * é o caso que antes não emitia nada, deixando "atualizado", "falhou" e "evento perdido" iguais.
 */
export interface UpdaterStatus {
  status: 'available' | 'not-available' | 'downloaded' | 'error'
  message?: string
  version?: string
}

export interface ModConfig {
  /** Nome do mod ao qual a config pertence (informativo) */
  mod: string
  filename: string
  /** Caminho relativo ao perfil onde o arquivo será escrito (ex: BepInEx/config/foo.cfg) */
  installPath: string
  /** Conteúdo literal do config OU uma URL http(s) de onde buscar o conteúdo */
  content: string
  /**
   * Pacote .zip (ex.: texturas): `content` é a URL do zip no R2 e `installPath` é a PASTA
   * destino dentro do perfil. Na instalação o launcher baixa o zip e EXTRAI o conteúdo lá
   * (preservando as subpastas); o .zip em si não fica no perfil do player.
   */
  extract?: boolean
}

export interface Modpack {
  version: string
  name: string
  description: string
  mods: Mod[]
  configs?: ModConfig[]
  updatedAt?: string
  battlemetricsId?: string
}

/**
 * Alvo do modpack no backend. Cada MUNDO público é um modpack independente
 * (`main` = Mundo 1, `main2` = Mundo 2); `admin` é o modpack secreto de teste.
 */
export type ModpackTarget = 'main' | 'main2' | 'admin'

/**
 * Um "mundo" do Hofheim: servidor próprio, com mods e configs próprios (o IP fica na
 * config de um dos mods). Para o jogador NÃO é um modpack separado na lista — ele
 * escolhe o modpack "Hofheim" e depois o mundo, nos cards da barra lateral.
 */
export interface WorldInfo {
  /** Nome curto exibido no card (ex.: "Mundo 1"). */
  label: string
  /** Uma linha de contexto no card (ex.: "Servidor principal"). */
  tagline: string
}

/** Identifica um modpack na barra lateral. */
export interface ModpackEntry {
  /** Id do perfil = pasta de instalação dos mods. Nunca muda depois de publicado. */
  id: string
  name: string
  type: 'vanilla' | 'public' | 'admin'
  builtin?: boolean
  /** Rota do modpack no backend. Ausente no vanilla (não tem modpack). */
  target?: ModpackTarget
  /** Quando presente, o modpack é um mundo do Hofheim (ver WorldInfo). */
  world?: WorldInfo
}

export interface Config {
  valheimPath: string
  installedMods: { name: string; version: string }[]
  /** Mods instalados por perfil/modpack (id -> lista). */
  installedByProfile?: Record<string, { name: string; version: string }[]>
  /**
   * Mods opcionais que o jogador ATIVOU, por perfil/modpack (id -> nomes dos mods).
   * Opcional é opt-in: fica desativado (não instala) até o player ligar o toggle.
   */
  optionalModsEnabled?: Record<string, string[]>
  /**
   * Hash do conjunto de configs do modpack já aplicado por perfil (id -> hash).
   * Permite reaplicar os configs quando o admin muda SÓ os configs (sem bump de
   * versão de mod), sem reescrever os arquivos — e apagar ajustes locais — a cada launch.
   */
  configsHashByProfile?: Record<string, string>
  selectedModpack?: string
  /** URL base do backend (Cloudflare Worker). */
  backendUrl?: string
  /** Repositório do modpack público no formato owner/repo. */
  modpackRepo?: string
  /** Branch do repositório do modpack (default: main). */
  modpackBranch?: string
  /** URL raw do news.json (opcional). */
  newsUrl?: string
  /** Pasta onde os perfis/mods são instalados. Default: %APPDATA%\HofheimLauncher\profiles */
  modsPath?: string
  /** Caminho da pasta BepInEx/config do perfil (r2modman ou outro). Usado pelo editor de configs do admin. */
  adminProfilePath?: string
}

/** Resposta da consulta direta ao servidor (Steam A2S no IP do servidor). */
export interface ServerStatus {
  online: boolean
  players: number
  maxPlayers: number
  name?: string
  version?: string
  keywords?: string
  /** Versão do jogo lida das tags do servidor (ex: 0.221.12-ServerCharacters). */
  gameVersion?: string
  queryPort?: number
  ping?: number
  error?: string
}

export interface PrivateModDownload {
  url: string
  headers?: Record<string, string>
}

declare global {
  interface Window {
    Hofheim: {
      window: {
        minimize: () => void
        maximize: () => void
        close: () => void
      }
      config: {
        load: () => Promise<Config>
        save: (config: Partial<Config>) => Promise<boolean>
      }
      dialog: {
        selectValheimPath: () => Promise<string | null>
      }
      valheim: {
        autoDetect: () => Promise<string>
      }
      mods: {
        defaultPath: () => Promise<string>
        install: (args: { zipPath: string; modName: string; profile: string }) => Promise<{ success: boolean; error?: string }>
        bepinexOk: (args: { profile: string }) => Promise<boolean>
        download: (args: { url: string; modName: string; headers?: Record<string, string>; sha256?: string }) => Promise<{ success: boolean; tempPath?: string; error?: string }>
        list: (profile: string) => Promise<string[]>
        remove: (args: { modName: string; profile: string }) => Promise<{ success: boolean; error?: string }>
        removeProfile: (profile: string) => Promise<{ success: boolean; path?: string; error?: string }>
        setOptionalEnabled: (args: { profile: string; modName: string; enabled: boolean; version?: string }) => Promise<{ success: boolean; moved?: boolean; version?: string; error?: string }>
        applyConfig: (args: { profile: string; installPath: string; content: string }) => Promise<{ success: boolean; error?: string }>
        /** `failed` = falha transitória (vale retentar); `invalid` = entrada quebrada no modpack (retentar não resolve). */
        applyConfigs: (args: { profile: string; configs: { installPath: string; content: string; filename?: string; extract?: boolean }[] }) => Promise<{ success: boolean; total?: number; applied?: number; skipped?: number; failed?: number; invalid?: number; error?: string }>
        /** `stage: 'zip'` = começou o download de um pacote .zip (pode demorar; ver ModConfig.extract). */
        onApplyConfigProgress: (callback: (data: { done: number; total: number; filename: string; stage?: 'zip' }) => void) => void
        offApplyConfigProgress: () => void
        readConfigsFromZip: (args: { url: string }) => Promise<{ success: boolean; configs?: { filename: string; installPath: string; content: string }[]; error?: string }>
        pickAndRead: () => Promise<{ filename: string; content: string; size: number } | null>
        pickModFile: () => Promise<{ token: string; filename: string; size: number } | null>
        uploadPrivateModStream: (args: { token: string; backendUrl: string; authToken: string }) => Promise<{ success: boolean; filename?: string; downloadUrl?: string; error?: string }>
        onUploadProgress: (callback: (data: { filename: string; sent: number; total: number }) => void) => void
        offUploadProgress: () => void
        importR2Code: (args: { code: string }) => Promise<{ success: boolean; mods?: { namespace: string; name: string; version: string }[]; configs?: { filename: string; installPath: string; content?: string; contentBase64?: string }[]; error?: string }>
        pickAndImportR2File: () => Promise<{ success: boolean; mods?: { namespace: string; name: string; version: string }[]; configs?: { filename: string; installPath: string; content?: string; contentBase64?: string }[]; error?: string } | null>
        openLog: (args: { valheimPath: string; profile?: string }) => Promise<{ success: boolean; error?: string }>
      }
      /** Configs enviados ao R2 pelo main process, sempre em streaming (o renderer não toca nos bytes). */
      configs: {
        /** Abre o diálogo do SO. `entries` = arquivos dentro do zip; `error` quando não é um zip válido. */
        pickZip: () => Promise<{ token: string; filename: string; size: number; entries: number } | { error: string } | null>
        uploadZipStream: (args: { token: string; backendUrl: string; authToken: string }) => Promise<{ success: boolean; filename?: string; url?: string; sha256?: string; error?: string }>
        /** Sobe um config do disco em PUT único streamado. Caminho padrão para config vindo de arquivo. */
        uploadFileStream: (args: { filePath: string; filename: string; backendUrl: string; authToken: string }) => Promise<{ success: boolean; url?: string; sha256?: string; error?: string }>
        onUploadProgress: (callback: (data: { filename: string; sent: number; total: number }) => void) => void
        offUploadProgress: () => void
      }
      game: {
        /** `warning`: o jogo subiu, mas falta uma configuração do jogador (ex.: Proton no Linux). */
        launch: (args: { valheimPath: string; mode: 'vanilla' | 'modded'; profile: string }) => Promise<{ success: boolean; error?: string; warning?: string }>
      }
      shell: {
        openExternal: (url: string) => void
      }
      fs: {
        pickDir: () => Promise<string | null>
        openInExplorer: (args: { dirPath: string }) => Promise<{ success: boolean; error?: string }>
        pickImage: () => Promise<{ filename: string; content: string; size: number } | null>
        /** `files` = extensões reconhecidas como config; `unknown` = demais arquivos da pasta (não somem em silêncio). */
        listDir: (args: { dir: string }) => Promise<{ success: boolean; files?: string[]; unknown?: string[]; error?: string }>
        readFile: (args: { filePath: string }) => Promise<{ success: boolean; content?: string; error?: string }>
        readFileBase64: (args: { filePath: string }) => Promise<{ success: boolean; content?: string; error?: string }>
        /** sha256 + tamanho lidos em streaming no main; usado pra saber se um binário mudou sem reenviá-lo. */
        hashFile: (args: { filePath: string }) => Promise<{ success: boolean; sha256?: string; size?: number; error?: string }>
        /** Libera uma pasta `config` arrastada na janela como raiz de leitura da sessão (só aceita pasta com esse nome). */
        allowDroppedConfigDir: (args: { dirPath: string }) => Promise<{ success: boolean; dirPath?: string; error?: string }>
        writeFile: (args: { filePath: string; content: string }) => Promise<{ success: boolean; error?: string }>
        pickJsonFile: () => Promise<string | null>
        saveFileDialog: (args: { filename: string; content: string }) => Promise<{ success: boolean }>
      }
      thunderstore: {
        fetchAll: () => Promise<any[]>
      }
      server: {
        status: (args: { address: string; timeoutMs?: number }) => Promise<ServerStatus>
      }
      app: {
        /** Versão INSTALADA do launcher (app.getVersion) + se o auto-update roda neste ambiente. */
        info: () => Promise<{ version: string; packaged: boolean; updaterSupported: boolean; platform: string }>
      }
      updater: {
        /** Checagem manual: responde o resultado (`reason: 'dev' | 'unsupported' | 'error'` quando não roda). */
        check: () => Promise<{
          success: boolean
          version: string
          latestVersion?: string
          reason?: 'dev' | 'unsupported' | 'error'
          error?: string
        }>
        install: () => Promise<void>
        /** Último status emitido, para o caso de a checagem ter terminado antes do React montar. */
        getStatus: () => Promise<UpdaterStatus | null>
        onStatus: (callback: (data: UpdaterStatus) => void) => void
        onProgress: (callback: (data: { percent: number; transferred: number; total: number }) => void) => void
      }
    }
  }
}
