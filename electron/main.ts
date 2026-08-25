import { app, BrowserWindow, ipcMain, dialog, shell, session, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { spawn, execFileSync } from 'child_process'
import { queryServerStatus, parseServerAddress } from './serverQuery'

const DATA_PATH = path.join(app.getPath('appData'), 'HofheimLauncher')
const CONFIG_FILE = path.join(DATA_PATH, 'config.json')
// Log de falhas de download. É o único artefato que o player consegue nos mandar quando
// "não baixa" — sem ele a mensagem amigável esconde o erro real (código TLS, HTTP, DNS).
const DOWNLOAD_LOG = path.join(DATA_PATH, 'download-errors.log')
const PROFILES_ROOT = path.join(DATA_PATH, 'profiles')

// Tamanho da parte do upload multipart de mod. R2 exige partes uniformes (exceto a
// última) e ≥5MB; o limite de body por request do Worker é ~100MB. 25MiB fica folgado.
const MOD_UPLOAD_PART_SIZE = 25 * 1024 * 1024

// Teto do config enviado em PUT único (configs:uploadFileStream). O corpo vai streamado,
// então não é memória que limita: é o body máximo por request do Worker (100MB no
// Free/Pro). 90MiB deixa margem. Acima disso o caminho é o multipart (configs:uploadZipStream).
const CONFIG_SINGLE_PUT_MAX = 90 * 1024 * 1024

// Arquivos de mod escolhidos no diálogo, por token opaco. O renderer recebe só o token
// (não o caminho absoluto), então não consegue mandar o app subir um arquivo arbitrário
// do disco — só o que o admin escolheu no diálogo do SO. Ver mods:pickModFile/uploadPrivateModStream.
const pickedModFiles = new Map<string, string>()

/**
 * Sanitiza um nome (mod/perfil) para uso seguro como UM segmento de caminho.
 * Remove qualquer separador ou `..`, bloqueando path traversal. Para nomes de mod
 * legítimos (ex.: "ValheimModding-Jotunn") é no-op, pois só contêm [A-Za-z0-9_-].
 */
function safeName(name?: string): string {
  return (name || 'mod').replace(/[^a-zA-Z0-9_-]/g, '_')
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Um download falhou por rede/TLS transitório (vale a pena tentar de novo) e não por erro
 * definitivo (404, integridade). O caso clássico é `BAD_DECRYPT` do BoringSSL: antivírus/proxy
 * que inspeciona HTTPS corrompe o stream TLS e a descriptografia falha — costuma passar numa nova
 * tentativa. Cobrimos também reset/timeout de conexão e respostas 429/5xx do servidor.
 */
function isRetryableNetworkError(err: any): boolean {
  const status = err?.response?.status
  if (status && (status === 429 || status >= 500)) return true
  const code = String(err?.code || '')
  if (/ECONNRESET|ETIMEDOUT|ECONNABORTED|EPIPE|EAI_AGAIN|ENETUNREACH|EPROTO|ERR_SSL/i.test(code)) return true
  const msg = String(err?.message || '')
  // `net::ERR_*` / "Failed to fetch" são a forma como a rota do Chromium reporta falha de
  // transporte (status HTTP lá não vira exceção), então também contam como transitórios.
  return /BAD_DECRYPT|decryption failed|ssl|tls|socket hang up|timeout|network|ECONNRESET|EPROTO|net::ERR_|Failed to fetch/i.test(msg)
}

/**
 * Erro de CADEIA DE CERTIFICADO — categoria diferente de "conexão caiu". Acontece quando algo
 * (antivírus com scan de HTTPS, proxy corporativo, VPN de filtragem) intercepta a conexão e
 * apresenta um certificado próprio: o Windows confia nele (o AV instala a CA raiz na loja do SO),
 * MAS o Node do Electron não — ele usa a lista de CAs embutida e ignora a loja do Windows.
 * Resultado clássico: o navegador do player baixa normal, o launcher não. Isso NÃO é transitório —
 * retentar com axios falha sempre. A saída é refazer o download pela pilha do Chromium (net.fetch),
 * que usa a loja de certificados do SO. Ver fetchViaChromium/downloadWithFallback.
 */
function isCertTrustError(err: any): boolean {
  const s = `${err?.code || ''} ${err?.message || ''}`
  // `ERR_CERT_*` é a versão do Chromium do mesmo problema (ex.: ERR_CERT_AUTHORITY_INVALID).
  return /SELF_SIGNED_CERT|self.signed certificate|UNABLE_TO_VERIFY_LEAF|UNABLE_TO_GET_ISSUER|DEPTH_ZERO_SELF_SIGNED|CERT_HAS_EXPIRED|CERT_UNTRUSTED|ERR_TLS_CERT_ALTNAME|ERR_CERT_|unable to get local issuer/i.test(s)
}

/** DNS não resolveu: provedor/roteador bloqueando ou DNS quebrado — não é o mesmo que TLS. */
function isDnsError(err: any): boolean {
  return /ENOTFOUND|EAI_AGAIN/i.test(`${err?.code || ''} ${err?.message || ''}`)
}

/** Vale tentar o caminho alternativo (Chromium) — qualquer falha de transporte, não de conteúdo. */
function isNetworkishError(err: any): boolean {
  return isRetryableNetworkError(err) || isCertTrustError(err) || isDnsError(err)
}

/**
 * Detalhe técnico curto do erro (código, HTTP, causa). Vai NO FIM da mensagem do player e no log:
 * sem isso, "a conexão foi interrompida" cobre desde DNS até 503 do CDN e não dá pra diagnosticar
 * remotamente — foi exatamente o que aconteceu no caso do BepInExPack_Valheim.
 */
function describeDownloadError(err: any): string {
  const parts: string[] = []
  const status = err?.response?.status
  if (status) parts.push(`HTTP ${status}`)
  if (err?.code) parts.push(String(err.code))
  const cause = err?.cause?.code
  if (cause && cause !== err?.code) parts.push(String(cause))
  const msg = String(err?.message || '').replace(/\s+/g, ' ').slice(0, 180)
  if (msg) parts.push(msg)
  return parts.join(' · ') || 'erro desconhecido'
}

/** Proxy configurado por variável de ambiente — axios o usa silenciosamente e ele pode estar morto. */
function proxyEnvNote(): string {
  const env = process.env
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
  return proxy ? ` Obs.: há um proxy configurado no sistema (${proxy}) — se ele não estiver mais ativo, remova a variável de ambiente.` : ''
}

/** Anexa uma linha ao log de downloads (rotaciona em 512KB). Best-effort: nunca quebra o fluxo. */
function logDownloadIssue(line: string): void {
  console.warn('[download]', line)
  try {
    fs.mkdirSync(DATA_PATH, { recursive: true })
    try {
      if (fs.statSync(DOWNLOAD_LOG).size > 512 * 1024) fs.unlinkSync(DOWNLOAD_LOG)
    } catch { /* log ainda não existe */ }
    fs.appendFileSync(DOWNLOAD_LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch { /* disco cheio/sem permissão: o log é auxiliar, o download continua */ }
}

/**
 * Log do ciclo de vida do auto-updater, no MESMO arquivo dos downloads (é o log que se pede ao
 * player). Sem ele, "o launcher não pediu pra atualizar" não tem como ser respondido: não dava
 * pra saber se a checagem rodou, se achou versão, se falhou ou se o updater estava desligado.
 */
function logUpdater(line: string): void {
  logDownloadIssue(`[updater] ${line}`)
}

/**
 * Erro do updater em linguagem de player. Os casos que aparecem na prática são: sem rede/DNS,
 * TLS interceptado por antivírus e instalação que precisa de elevação (app em Program Files
 * instalado por uma versão antiga, onde o update silencioso não consegue escrever).
 */
function friendlyUpdaterError(err: any): string {
  const raw = String(err?.message || err || '')
  if (isCertTrustError(err) || /BAD_DECRYPT|unable to verify|self.signed/i.test(raw)) {
    return 'A conexão com o servidor de atualizações foi bloqueada (normalmente antivírus ou VPN inspecionando HTTPS). ' +
      'Desative a inspeção de HTTPS/SSL do antivírus e tente de novo.'
  }
  if (isDnsError(err)) {
    return 'Não foi possível resolver o endereço do servidor de atualizações. Verifique sua conexão/DNS.'
  }
  if (/EPERM|EACCES|elevat|permission/i.test(raw)) {
    return 'A atualização não conseguiu escrever na pasta de instalação. Reinstale o launcher usando o instalador mais recente ' +
      '(instale só para o seu usuário, não em Program Files).'
  }
  if (/404|no published versions|latest.yml/i.test(raw)) {
    return 'O servidor de atualizações não devolveu uma versão publicada. Se a release acabou de sair, aguarde alguns minutos.'
  }
  return raw || 'Falha desconhecida ao verificar atualizações.'
}

/**
 * Converte o erro cru de um download numa mensagem que o jogador entende e consegue agir.
 * Sem isso, uma falha de TLS aparecia como o despejo do OpenSSL (`error:...BAD_DECRYPT: e_aes.c`),
 * que assusta e não diz o que fazer. Cada causa tem uma ação diferente — antes tudo virava
 * "desative o antivírus", o que fazia o player perder tempo quando o problema era o CDN ou o DNS.
 */
function friendlyDownloadError(err: any, modName: string): string {
  const detail = ` (detalhe: ${describeDownloadError(err)}; log em ${DOWNLOAD_LOG})`
  const status = err?.response?.status
  if (status && (status === 429 || status >= 500)) {
    return `Falha ao baixar ${modName}: o servidor de mods respondeu com erro (${status}). ` +
      `Não é problema do seu PC — espere alguns minutos e clique em jogar de novo.${detail}`
  }
  if (isDnsError(err)) {
    return `Falha ao baixar ${modName}: não foi possível resolver o endereço do servidor de mods (DNS). ` +
      `Tente trocar o DNS do Windows para 1.1.1.1 ou 8.8.8.8, reiniciar o roteador, ou testar em outra rede ` +
      `(ex.: roteando pelo celular).${proxyEnvNote()}${detail}`
  }
  if (isCertTrustError(err)) {
    return `Falha ao baixar ${modName}: o certificado do servidor não foi aceito — algo está interceptando a conexão ` +
      `(antivírus com scan de HTTPS, proxy da empresa/faculdade ou VPN de filtragem). Adicione o Hofheim Launcher ` +
      `às exceções do antivírus, desligue o scan de HTTPS/web, ou use outra rede.${proxyEnvNote()}${detail}`
  }
  if (isRetryableNetworkError(err)) {
    return `Falha ao baixar ${modName}: a conexão foi interrompida ou corrompida. ` +
      `Geralmente é o antivírus (inspeção de HTTPS/SSL), uma VPN ou proxy mexendo na conexão. ` +
      `Tente: desativar temporariamente o scan de web do antivírus ou adicionar o Hofheim Launcher às exceções, ` +
      `desligar VPN/proxy, ou trocar de rede — e clique em jogar de novo.${proxyEnvNote()}${detail}`
  }
  return `Falha ao baixar ${modName}: ${err?.message || 'erro desconhecido'}${detail}`
}

/**
 * Baixa pela pilha de rede do Chromium (Electron `net`) em vez do Node. Diferenças que importam:
 * usa a LOJA DE CERTIFICADOS DO WINDOWS (então aceita a CA raiz que o antivírus/proxy instalou) e
 * as configurações de proxy do SO. É o plano B quando o axios falha por transporte — mesma URL,
 * mesmos headers, caminho de rede diferente.
 */
async function fetchViaChromium(url: string, headers?: Record<string, string>): Promise<Buffer> {
  // `no-store`: a rota Chromium usa o cache HTTP da sessão. Quando o admin republica um mod na
  // MESMA url (mod privado servido pelo backend), o cache devolvia o zip antigo e o jogador
  // reinstalava exatamente a versão que estava tentando trocar. Download de mod sempre vai à rede.
  const res = await net.fetch(url, { headers: headers || undefined, redirect: 'follow', cache: 'no-store' })
  if (!res.ok) {
    const e: any = new Error(`HTTP ${res.status} ${res.statusText}`)
    e.response = { status: res.status }
    throw e
  }
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Rota preferida de download NESTA SESSÃO. Começa no node (axios, caminho histórico) e vira
 * 'chromium' assim que um mod só consegue baixar pelo fallback — o que significa que o ambiente
 * do player quebra a pilha do node (AV interceptando HTTPS, proxy do SO). Sem esse estado, CADA
 * mod do modpack pagaria de novo as 3 tentativas + ~4s de backoff antes do fallback: num modpack
 * de dezenas de mods são minutos de espera garantida. Não é persistido em disco de propósito —
 * o player pode desligar o AV entre sessões, e reabrir o launcher volta a testar o node.
 */
let preferredRoute: 'node' | 'chromium' = 'node'

/**
 * Rota node/axios, com retry e backoff: falhas de rede/TLS transitórias costumam passar numa nova
 * tentativa. Erros definitivos (404, certificado) saem na hora — retentar não muda o resultado.
 */
async function downloadViaNodeRoute(url: string, modName: string, headers?: Record<string, string>): Promise<Buffer> {
  const axios = require('axios')
  const MAX_ATTEMPTS = 3
  let lastErr: any
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: headers || undefined,
        maxRedirects: 5,
        timeout: 120000,
        maxContentLength: 512 * 1024 * 1024, // teto de 512MB contra payloads gigantes
        maxBodyLength: 512 * 1024 * 1024,
      })
      return Buffer.from(response.data)
    } catch (err: any) {
      lastErr = err
      logDownloadIssue(`${modName}: tentativa ${attempt}/${MAX_ATTEMPTS} (node/axios) falhou — ${describeDownloadError(err)}`)
      if (!isRetryableNetworkError(err)) break
      if (attempt < MAX_ATTEMPTS) await sleep(attempt * 2000 - 1000) // 1s, 3s
    }
  }
  throw lastErr
}

/** Rota Chromium (net.fetch), com o mesmo retry — aqui a falha transitória também é possível. */
async function downloadViaChromiumRoute(url: string, modName: string, headers?: Record<string, string>): Promise<Buffer> {
  const MAX_ATTEMPTS = 3
  let lastErr: any
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchViaChromium(url, headers)
    } catch (err: any) {
      lastErr = err
      logDownloadIssue(`${modName}: tentativa ${attempt}/${MAX_ATTEMPTS} (chromium/net) falhou — ${describeDownloadError(err)}`)
      if (!isNetworkishError(err)) break
      if (attempt < MAX_ATTEMPTS) await sleep(attempt * 2000 - 1000) // 1s, 3s
    }
  }
  throw lastErr
}

/**
 * Parseia os bytes de um perfil r2modman (ZIP contendo `export.r2x` + pasta `config/`)
 * para a lista de mods e configs do Hofheim. É o MESMO conteúdo tanto de um arquivo
 * `.r2z` local quanto do código de perfil resolvido via Thunderstore (`#r2modman` +
 * base64), então ambos os caminhos de importação reusam esta função.
 *
 * Campos confirmados contra r2modmanPlus: mods[].name é "Namespace-ModName",
 * version é {major,minor,patch}, enabled default true.
 * Fonte: https://github.com/ebkr/r2modmanPlus
 */
// Extensões de config binário — espelha BINARY_CONFIG_EXT_RE em src/utils/modManager.ts.
// Binários (imagem/música/gif/fonte) não podem virar string; são retornados como base64
// para o editor subir ao R2 em vez de embutir no modpack.
const R2_BINARY_CONFIG_RE =
  /\.(png|jpe?g|gif|webp|bmp|ico|tga|dds|mp3|ogg|wav|flac|aac|m4a|mp4|webm|mov|mkv|ttf|otf|woff2?|zip|dll|bin|dat|pdf|unity3d|assetbundle|bundle)$/i

function parseR2ProfileZip(zipBuffer: Buffer):
  | { success: true; mods: { namespace: string; name: string; version: string }[]; configs: { filename: string; installPath: string; content?: string; contentBase64?: string }[] }
  | { success: false; error: string } {
  const AdmZip = require('adm-zip')
  let zip: any
  try {
    zip = new AdmZip(zipBuffer)
  } catch {
    return { success: false, error: 'Arquivo não é um ZIP válido (esperado um perfil .r2z do R2ModManager)' }
  }
  const entry = zip.getEntry('export.r2x')
  if (!entry) return { success: false, error: 'Arquivo export.r2x não encontrado no perfil — este não parece ser um .r2z do R2ModManager' }

  const yaml = require('yaml')
  let parsed: any
  try {
    parsed = yaml.parse(zip.readAsText(entry))
  } catch (err: any) {
    return { success: false, error: `Falha ao ler export.r2x: ${err.message}` }
  }
  if (typeof parsed?.profileName !== 'string' || !Array.isArray(parsed?.mods)) {
    return { success: false, error: 'export.r2x do perfil está com formato inválido' }
  }

  const mods = parsed.mods
    .filter((m: any) => m?.enabled === undefined || m.enabled)
    .map((m: any) => {
      const parts = String(m.name).split('-')
      return {
        namespace: parts[0],
        name: parts.slice(1).join('-'),
        version: `${m.version?.major ?? 0}.${m.version?.minor ?? 0}.${m.version?.patch ?? 0}`,
      }
    })
    .filter((m: { namespace: string; name: string }) => m.namespace && m.name)

  // Extrai configs da pasta config/ PRESERVANDO a estrutura de subpastas (ex.:
  // config/DistantOrigins/Translations/Mod/Mod.French.yml). Achatar tudo para
  // BepInEx/config/<nome> criava uma segunda cópia num caminho diferente do que o
  // próprio mod instala, gerando "Duplicate key ... skipped". Mantendo o caminho, o
  // config do perfil sobrescreve o padrão do mod — igual ao r2modman.
  const configs: { filename: string; installPath: string; content?: string; contentBase64?: string }[] = []
  zip.getEntries().forEach((e: any) => {
    if (e.isDirectory) return
    const name = String(e.entryName).replace(/\\/g, '/')
    if (!name.startsWith('config/')) return
    const rel = name.slice('config/'.length)
    if (!rel || rel.includes('..')) return
    // Pula backups/cache/lixo que alguns mods geram em config/ e não são config de verdade:
    // ExpandWorld salva *.yaml.bak; wackysDatabase compila cache em Cache/*.zz (regenerado em
    // runtime). Incham o modpack e têm extensão que o R2 não aceita — fora do pacote.
    if (/\.(bak|old|orig|tmp|swp|disabled|zz)$|~$/i.test(rel)) return
    if (/(^|\/)Cache\//i.test(rel)) return
    const base = { filename: path.posix.basename(rel), installPath: `BepInEx/config/${rel}` }
    if (R2_BINARY_CONFIG_RE.test(rel)) {
      // Binário (ex.: música .ogg, gif, spritesheet .png): lê os BYTES crus como base64.
      // Ler como texto (readAsText) destruiria o arquivo. O editor sobe pro R2.
      configs.push({ ...base, contentBase64: e.getData().toString('base64') })
    } else {
      configs.push({ ...base, content: zip.readAsText(e) })
    }
  })

  return { success: true, mods, configs }
}

/**
 * Raízes cujo conteúdo o renderer pode ler/gravar via fs:* — a raiz de perfis mais
 * qualquer pasta que o usuário tenha escolhido explicitamente num diálogo do SO nesta
 * sessão. Sem isso, fs:readFile/writeFile aceitariam QUALQUER caminho do disco vindo do
 * renderer (leitura/escrita arbitrária = RCE se o renderer for comprometido).
 */
const allowedFsRoots = new Set<string>()

/**
 * Registra como raízes liberadas os caminhos que o PRÓPRIO usuário configurou (pasta do Valheim,
 * pasta de mods). São tão confiáveis quanto uma pasta escolhida em diálogo — só que persistidos no
 * config.json entre sessões. Sem isso, após reiniciar o launcher o valheimPath vindo do config não
 * estaria liberado e ações como "Abrir pasta" falhariam.
 */
function registerConfiguredRoots(config: any) {
  // `adminProfilePath` entra junto: ele só existe na config porque o admin JÁ escolheu essa pasta
  // num diálogo antes. Sem re-liberá-la ao carregar, o caminho lembrado voltava na tela mas
  // qualquer Listar/ler dava "Acesso negado" até ele escolher a pasta de novo pelo diálogo.
  for (const p of [config?.valheimPath, config?.modsPath, config?.adminProfilePath]) {
    if (typeof p === 'string' && p) allowedFsRoots.add(path.resolve(p))
  }
}

/** Um caminho está liberado se cair dentro da raiz de perfis ou de uma pasta escolhida em diálogo. */
function isPathAllowed(p: string): boolean {
  const target = path.resolve(p)
  const roots = [getProfilesRoot(), ...allowedFsRoots]
  return roots.some(root => {
    const r = path.resolve(root)
    return target === r || target.startsWith(r + path.sep)
  })
}

/** Procura um arquivo pelo nome recursivamente; retorna o caminho ou null. */
function findFileInDir(dir: string, filename: string): string | null {
  if (!fs.existsSync(dir)) return null
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stat = fs.statSync(full)
    if (stat.isFile() && entry.toLowerCase() === filename.toLowerCase()) return full
    if (stat.isDirectory()) {
      const found = findFileInDir(full, filename)
      if (found) return found
    }
  }
  return null
}

/** Copia uma pasta recursivamente (merge, não substitui pastas). */
function copyDirRecursive(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry)
    const destPath = path.join(dest, entry)
    if (fs.statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

/** Lista arquivos de uma pasta recursivamente, como caminhos relativos a ela. */
function listFilesRecursive(dir: string, prefix = ''): string[] {
  let out: string[] = []
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry)
    const rel = prefix ? path.join(prefix, entry) : entry
    if (fs.statSync(full).isDirectory()) out = out.concat(listFilesRecursive(full, rel))
    else out.push(rel)
  }
  return out
}

/**
 * Caminho do manifesto de um mod dentro do perfil. Registra os arquivos que o install
 * roteou para PASTAS COMPARTILHADAS (patchers/monomod/core) — que o mods:remove não teria
 * como localizar de outra forma, já que seus nomes não têm relação com o nome do mod.
 */
function modManifestPath(profileRoot: string, modName: string): string {
  return path.join(profileRoot, '.Hofheim', 'installed', `${safeName(modName)}.json`)
}

/** Grava o manifesto de um mod com a lista de arquivos externos (relativos ao perfil). */
function writeModManifest(profileRoot: string, modName: string, external: string[]) {
  const mf = modManifestPath(profileRoot, modName)
  fs.mkdirSync(path.dirname(mf), { recursive: true })
  fs.writeFileSync(mf, JSON.stringify({ external }, null, 2))
}

/** Sobe removendo pastas que ficaram vazias, parando em (sem apagar) `stop`. */
function pruneEmptyParents(fileAbs: string, stop: string) {
  const stopAbs = path.resolve(stop)
  let dir = path.dirname(path.resolve(fileAbs))
  while (dir.startsWith(stopAbs + path.sep) && dir !== stopAbs) {
    try {
      if (fs.readdirSync(dir).length > 0) break
      fs.rmdirSync(dir)
      dir = path.dirname(dir)
    } catch { break }
  }
}

/** Move um arquivo/pasta (rename rápido no mesmo disco; cai p/ copy+rm se cruzar discos). */
function movePath(src: string, dest: string) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try {
    fs.renameSync(src, dest)
  } catch (e: any) {
    if (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'ENOTEMPTY') {
      if (fs.statSync(src).isDirectory()) {
        copyDirRecursive(src, dest)
        fs.rmSync(src, { recursive: true, force: true })
      } else {
        fs.copyFileSync(src, dest)
        fs.rmSync(src, { force: true })
      }
    } else throw e
  }
}

/** Depósito de um mod desativado dentro do perfil (fora da árvore que o BepInEx varre). */
function disabledStoreDir(profileRoot: string, modName: string): string {
  return path.join(profileRoot, '.Hofheim', 'disabled', safeName(modName))
}

/**
 * Desativa um mod SEM apagar (estilo r2modman): MOVE a pasta do plugin e os arquivos que o
 * install roteou para pastas compartilhadas (patchers/monomod/core, do manifesto) para um
 * depósito em .Hofheim/disabled/<mod>/. O BepInEx para de carregá-los, mas religar não re-baixa.
 * Retorna { moved } — moved=false quando não havia nada instalado (nada a mover).
 */
function disableModFiles(profileRoot: string, modName: string, version?: string): { moved: boolean; version?: string } {
  const store = disabledStoreDir(profileRoot, modName)
  const pluginDir = path.join(profileRoot, 'BepInEx', 'plugins', safeName(modName))
  const hadPlugin = fs.existsSync(pluginDir)

  // Arquivos externos (patchers/monomod/core) registrados no manifesto do install.
  const mf = modManifestPath(profileRoot, modName)
  let external: string[] = []
  if (fs.existsSync(mf)) {
    try { external = (JSON.parse(fs.readFileSync(mf, 'utf-8')).external || []) as string[] } catch { /* ignora */ }
  }

  if (!hadPlugin && external.length === 0) return { moved: false }

  // Zera um depósito antigo (ex.: religar interrompido no meio) antes de reencher.
  if (fs.existsSync(store)) fs.rmSync(store, { recursive: true, force: true })

  if (hadPlugin) movePath(pluginDir, path.join(store, 'plugins', safeName(modName)))

  const bepinex = path.join(profileRoot, 'BepInEx')
  const movedExternal: string[] = []
  for (const rel of external) {
    const from = path.resolve(profileRoot, rel)
    // Segurança: só mexe dentro do perfil (bloqueia path traversal em manifesto adulterado).
    if (from !== profileRoot && !from.startsWith(path.resolve(profileRoot) + path.sep)) continue
    if (fs.existsSync(from)) {
      movePath(from, path.join(store, 'external', rel))
      movedExternal.push(rel)
      pruneEmptyParents(from, bepinex)
    }
  }

  fs.mkdirSync(store, { recursive: true })
  fs.writeFileSync(
    path.join(store, 'meta.json'),
    JSON.stringify({ modName, version: version || null, external: movedExternal }, null, 2),
  )
  return { moved: true, version }
}

/**
 * Religa um mod desativado movendo os arquivos do depósito de volta aos locais ativos do
 * BepInEx. Retorna { moved, version } — moved=false quando não há depósito (nunca instalado):
 * nesse caso quem cuida é o fluxo normal de download/install.
 */
function enableModFiles(profileRoot: string, modName: string): { moved: boolean; version?: string } {
  const store = disabledStoreDir(profileRoot, modName)
  if (!fs.existsSync(store)) return { moved: false }

  let meta: { version?: string | null; external?: string[] } = {}
  try { meta = JSON.parse(fs.readFileSync(path.join(store, 'meta.json'), 'utf-8')) } catch { /* segue */ }

  const storedPlugin = path.join(store, 'plugins', safeName(modName))
  if (fs.existsSync(storedPlugin)) {
    const dest = path.join(profileRoot, 'BepInEx', 'plugins', safeName(modName))
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true })
    movePath(storedPlugin, dest)
  }

  for (const rel of meta.external || []) {
    const from = path.join(store, 'external', rel)
    if (fs.existsSync(from)) movePath(from, path.resolve(profileRoot, rel))
  }

  fs.rmSync(store, { recursive: true, force: true })
  return { moved: true, version: meta.version || undefined }
}

/** Localiza o BepInEx Preloader dentro de <perfil>/BepInEx/core (nome varia por runtime). */
function findPreloaderDll(coreDir: string): string | null {
  if (!fs.existsSync(coreDir)) return null
  const known = [
    'BepInEx.Preloader.dll',            // Valheim / Unity Mono (5.4.x)
    'BepInEx.Unity.Mono.Preloader.dll',
    'BepInEx.IL2CPP.dll',
    'BepInEx.Unity.IL2CPP.dll',
    'BepInEx.NET.CoreCLR.dll',
  ]
  const files = fs.readdirSync(coreDir)
  const hit = known.find(k => files.includes(k))
  return hit ? path.join(coreDir, hit) : null
}

/** Copia um arquivo só se estiver ausente ou diferente no destino (tamanho ou mtime). */
function copyFileIfChanged(src: string, dest: string) {
  try {
    const s = fs.statSync(src)
    if (fs.existsSync(dest)) {
      const d = fs.statSync(dest)
      // copyFileSync não preserva mtime, então o destino fica >= origem quando já está atualizado.
      if (d.size === s.size && d.mtimeMs >= s.mtimeMs) return
    }
  } catch { /* em dúvida, copia */ }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
}

/**
 * Sincroniza src → dest copiando apenas o que mudou (rápido em launches repetidos).
 * Com `mirror`, remove do destino o que não existe mais na origem (limpa mods removidos
 * e versões duplicadas). Sem `mirror`, nunca apaga (preserva configs gerados em runtime).
 */
function syncDir(src: string, dest: string, mirror: boolean) {
  if (!fs.existsSync(src)) return
  fs.mkdirSync(dest, { recursive: true })
  const srcEntries = fs.readdirSync(src)
  if (mirror && fs.existsSync(dest)) {
    const keep = new Set(srcEntries)
    for (const name of fs.readdirSync(dest)) {
      if (!keep.has(name)) fs.rmSync(path.join(dest, name), { recursive: true, force: true })
    }
  }
  for (const name of srcEntries) {
    const s = path.join(src, name)
    const d = path.join(dest, name)
    if (fs.statSync(s).isDirectory()) syncDir(s, d, mirror)
    else copyFileIfChanged(s, d)
  }
}

/**
 * Subpastas de topo de um pacote Thunderstore que o BepInEx espera em locais
 * próprios (fora de plugins/). Espelha as install rules do r2modman.
 */
const BEPINEX_ROUTES: Record<string, string> = {
  config: 'config',
  patchers: 'patchers',
  monomod: 'monomod',
  core: 'core',
  plugins: 'plugins',
}

/**
 * Roteia o conteúdo de um pacote Thunderstore já extraído (staging) para os
 * locais corretos do BepInEx, imitando as install rules do r2modman:
 *   config/   → BepInEx/config/   (preservando subpastas — é isso que gera as
 *               pastas separadas de config que alguns mods criam)
 *   patchers/ → BepInEx/patchers/
 *   monomod/  → BepInEx/monomod/
 *   core/     → BepInEx/core/
 *   plugins/  → BepInEx/plugins/<modName>/
 *   restante (dll solta, manifest, readme, icon, assets…) → BepInEx/plugins/<modName>/
 */
function routeModContents(staging: string, profileRoot: string, modName: string): string[] {
  // Desce por pastas-invólucro (uma única subpasta, sem arquivos soltos) até a raiz do pacote.
  let root = staging
  for (;;) {
    const entries = fs.readdirSync(root)
    const subdirs = entries.filter(e => fs.statSync(path.join(root, e)).isDirectory())
    const files = entries.filter(e => fs.statSync(path.join(root, e)).isFile())
    if (files.length === 0 && subdirs.length === 1) {
      root = path.join(root, subdirs[0])
    } else {
      break
    }
  }

  const pluginTarget = path.join(profileRoot, 'BepInEx', 'plugins', modName)
  // Arquivos criados em pastas compartilhadas (patchers/monomod/core), para o mods:remove.
  // config/ NÃO entra aqui: é preservado na remoção, igual ao r2modman.
  const external: string[] = []

  for (const entry of fs.readdirSync(root)) {
    const full = path.join(root, entry)
    const isDir = fs.statSync(full).isDirectory()
    const routed = isDir ? BEPINEX_ROUTES[entry.toLowerCase()] : undefined

    if (routed && routed !== 'plugins') {
      // config / patchers / monomod / core → BepInEx/<routed>/ (mantém subestrutura)
      const destDir = path.join(profileRoot, 'BepInEx', routed)
      copyDirRecursive(full, destDir)
      if (routed !== 'config') {
        for (const rel of listFilesRecursive(full)) {
          external.push(path.relative(profileRoot, path.join(destDir, rel)))
        }
      }
    } else if (routed === 'plugins') {
      // conteúdo de plugins/ do pacote entra na pasta do próprio mod
      copyDirRecursive(full, pluginTarget)
    } else if (isDir) {
      // pasta desconhecida (assets etc.) → plugins/<modName>/ preservando estrutura
      copyDirRecursive(full, path.join(pluginTarget, entry))
    } else {
      // arquivo solto (dll, manifest, readme, icon…) → plugins/<modName>/
      fs.mkdirSync(pluginTarget, { recursive: true })
      fs.copyFileSync(full, path.join(pluginTarget, entry))
    }
  }

  return external
}

/**
 * Migra instalações antigas: versões anteriores do launcher extraíam o pacote
 * Thunderstore inteiro dentro de plugins/<mod>/, deixando config/patchers/monomod
 * aninhados lá em vez dos locais corretos do BepInEx. Isso duplica arquivos
 * (ex.: traduções .yml carregadas duas vezes → "Duplicate key ... will be skipped")
 * e pode impedir o jogo de rodar. Move essas subpastas para fora.
 *
 * RODA UMA VEZ POR PERFIL (marcador em .Hofheim/). Antes rodava na abertura do launcher E em
 * todo launch modado, e isso quebrava o caso normal: vários mods CRIAM uma pasta `config/`
 * dentro do próprio plugins/<mod>/ enquanto o jogo roda (assets, texturas, traduções). O launch
 * seguinte varria essa pasta e despejava o conteúdo solto em BepInEx/config/ — era o
 * "instalo do zero e fica certo, depois de jogar os arquivos aparecem soltos em config/".
 * Como o install já roteia config/ do pacote pro lugar certo (routeModContents), depois da
 * primeira passada não há mais nada legítimo pra migrar: o que aparecer ali é do runtime do mod.
 */
const NESTED_MIGRATION_STAMP = 'migrated-nested-bepinex-v1'

function migrateNestedBepInExFolders(profileRoot: string): number {
  const stamp = path.join(profileRoot, '.Hofheim', NESTED_MIGRATION_STAMP)
  if (fs.existsSync(stamp)) return 0

  const pluginsRoot = path.join(profileRoot, 'BepInEx', 'plugins')
  let moved = 0
  if (fs.existsSync(pluginsRoot)) {
    for (const mod of fs.readdirSync(pluginsRoot)) {
      const modDir = path.join(pluginsRoot, mod)
      if (!fs.statSync(modDir).isDirectory()) continue
      for (const sub of ['config', 'patchers', 'monomod']) {
        const nested = path.join(modDir, sub)
        if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
          copyDirRecursive(nested, path.join(profileRoot, 'BepInEx', sub))
          fs.rmSync(nested, { recursive: true, force: true })
          moved++
        }
      }
    }
  }

  // Marca mesmo sem ter movido nada: o objetivo é NUNCA varrer de novo os plugins deste perfil.
  try {
    fs.mkdirSync(path.dirname(stamp), { recursive: true })
    fs.writeFileSync(stamp, new Date().toISOString())
  } catch { /* sem permissão: no pior caso a migração roda de novo no próximo launch */ }
  return moved
}

/** Roda a migração acima em todos os perfis existentes (uma vez por perfil, via marcador). */
function migrateAllProfiles() {
  try {
    const root = getProfilesRoot()
    if (!fs.existsSync(root)) return
    for (const profile of fs.readdirSync(root)) {
      // Pastas internas (ex.: `.trash-*`, restos de uma remoção de perfil) não são perfis.
      if (profile.startsWith('.')) continue
      const p = path.join(root, profile)
      try {
        if (fs.statSync(p).isDirectory()) {
          const n = migrateNestedBepInExFolders(p)
          if (n > 0) console.log(`[migrate] ${profile}: ${n} pasta(s) movida(s) de plugins/ para BepInEx/`)
        }
      } catch { /* ignora erros por perfil */ }
    }
  } catch { /* ignora */ }
}

/** Retorna a raiz de perfis: config.modsPath se definido, senão o default. */
function getProfilesRoot(): string {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
      if (cfg.modsPath) return cfg.modsPath
    }
  } catch { /* ignore */ }
  return PROFILES_ROOT
}

/**
 * Apaga restos de `.trash-*` — pastas de perfil que o plano B da remoção tirou do caminho
 * (rename) mas não conseguiu apagar na hora porque algo ainda segurava um arquivo.
 */
function sweepProfileTrash(root: string) {
  try {
    for (const entry of fs.readdirSync(root)) {
      if (!entry.startsWith('.trash-')) continue
      try {
        fs.rmSync(path.join(root, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch { /* ainda em uso; tenta de novo na próxima remoção */ }
    }
  } catch { /* raiz inexistente */ }
}

/** Sanitiza o id do modpack para usar como nome de pasta de perfil. */
function profileDir(profile: string): string {
  return path.join(getProfilesRoot(), safeName(profile || 'default'))
}

function ensureDirs(profile?: string) {
  const root = getProfilesRoot()
  const dirs = [DATA_PATH, root]
  let freshProfile: string | null = null
  if (profile) {
    const p = profileDir(profile)
    // Perfil que está sendo CRIADO agora não tem nada de instalação antiga para migrar: já nasce
    // com o roteamento correto do install. Marcá-lo aqui evita que a varredura de plugins/ rode
    // nele e leve embora as pastas `config/` que os mods criam em runtime.
    if (!fs.existsSync(p)) freshProfile = p
    dirs.push(p, path.join(p, 'BepInEx', 'plugins'), path.join(p, 'BepInEx', 'config'))
  }
  dirs.forEach(p => {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
  })
  if (freshProfile) {
    try {
      const stamp = path.join(freshProfile, '.Hofheim', NESTED_MIGRATION_STAMP)
      fs.mkdirSync(path.dirname(stamp), { recursive: true })
      fs.writeFileSync(stamp, new Date().toISOString())
    } catch { /* best-effort: sem o marcador a migração roda uma vez e marca depois */ }
  }
}

// ── Aplicação de configs (incremental) ─────────────────────────────────────────────
// O modpack pode ter milhares de configs (texto inline + centenas de URLs do R2). Aplicar
// todos a cada launch reescreve/rebaixa tudo sem necessidade — lento e desnecessário. Guardamos
// um registro por perfil (installPath -> hash do conteúdo) e só (re)aplicamos o que mudou ou
// sumiu do disco. Assim, um relaunch sem mudanças pula tudo instantaneamente.

/** djb2 estável de um único config (installPath + content) — marcador do que já foi aplicado. */
function hashConfigEntry(installPath: string, content: string): string {
  const s = `${installPath} ${content || ''}`
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return String(h >>> 0)
}

/** Resolve o alvo de um config dentro do perfil, bloqueando path traversal. null se inválido. */
function resolveConfigTarget(profile: string, installPath: string): string | null {
  const base = path.resolve(profileDir(profile))
  // Separador no prefixo evita que uma pasta IRMÃ com o mesmo prefixo (ex.: <perfil>_evil) passe.
  const target = path.resolve(base, installPath)
  if (target !== base && !target.startsWith(base + path.sep)) return null
  return target
}

/**
 * Grava um config no disco. Se `content` for URL http(s) (binário/texto grande offloaded pro R2),
 * baixa os BYTES crus e grava (preserva binário E texto); senão escreve a string inline.
 */
async function writeConfigToDisk(target: string, content: string): Promise<void> {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const trimmed = (content || '').trim()
  if (/^https?:\/\//i.test(trimmed)) {
    const axios = require('axios')
    // Retry com backoff, igual ao download de mod: são centenas de configs por perfil e uma
    // falha transitória (TLS interceptado por antivírus, socket morto, 503 da borda) deixava o
    // config de fora — e como o registro não marca o que falhou, o player repetia o download
    // desses mesmos arquivos em TODO launch. Erro definitivo (404) sai na primeira.
    const MAX_ATTEMPTS = 3
    let lastErr: any
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await axios.get(trimmed, { responseType: 'arraybuffer', timeout: 60000, maxRedirects: 5 })
        fs.writeFileSync(target, Buffer.from(res.data))
        return
      } catch (err: any) {
        lastErr = err
        if (!isNetworkishError(err)) break
        if (attempt < MAX_ATTEMPTS) await sleep(attempt * 1000) // 1s, 2s
      }
    }
    throw lastErr
  } else {
    fs.writeFileSync(target, content)
  }
}

const appliedConfigsFile = (profile: string) => path.join(profileDir(profile), '.Hofheim', 'applied-configs.json')

function readAppliedConfigs(profile: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(appliedConfigsFile(profile), 'utf-8')) } catch { return {} }
}

function writeAppliedConfigs(profile: string, rec: Record<string, string>) {
  const f = appliedConfigsFile(profile)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(rec))
}

// ── Pacotes de config em .zip (ex.: texturas) ──────────────────────────────────────
// Um config com `extract: true` não é um arquivo: é um .zip no R2 cujo CONTEÚDO é
// extraído dentro do perfil (installPath = pasta destino). Precisa de registro próprio
// porque um zip vira N arquivos — guardamos a lista pra poder limpar os antigos quando o
// admin troca o pacote (senão texturas removidas ficariam pra sempre no perfil do player).

type AppliedZip = { hash: string; files: string[] }

const appliedZipsFile = (profile: string) => path.join(profileDir(profile), '.Hofheim', 'applied-config-zips.json')

function readAppliedZips(profile: string): Record<string, AppliedZip> {
  try { return JSON.parse(fs.readFileSync(appliedZipsFile(profile), 'utf-8')) } catch { return {} }
}

function writeAppliedZips(profile: string, rec: Record<string, AppliedZip>) {
  const f = appliedZipsFile(profile)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(rec))
}

/** Chave de registro de um pacote zip. Dois zips podem extrair na MESMA pasta, então o nome entra na chave. */
const zipEntryKey = (installPath: string, filename?: string) => `${installPath}|${filename || 'pack.zip'}`

/** Baixa uma URL pra um arquivo temporário em streaming (zip de textura pode ter centenas de MB). */
async function downloadToTempFile(url: string, hintName: string): Promise<string> {
  const axios = require('axios')
  const tempPath = path.join(os.tmpdir(), `Hofheim-cfg-${safeName(hintName)}-${Date.now()}.zip`)
  const res = await axios.get(url, {
    responseType: 'stream',
    // Sem timeout de resposta total: o corpo pode levar minutos numa conexão ruim. O axios
    // já falha se a conexão morrer; o timeout curto aqui cortaria downloads legítimos.
    timeout: 60000,
    maxRedirects: 5,
  })
  await new Promise<void>((resolve, reject) => {
    const ws = fs.createWriteStream(tempPath)
    res.data.pipe(ws)
    res.data.on('error', reject)
    ws.on('error', reject)
    ws.on('finish', () => resolve())
  })
  return tempPath
}

/**
 * Extrai um zip de config dentro do perfil. Cada entrada é confinada em `destDir`
 * (entrada com `../` no nome é ignorada — zip slip). Retorna os caminhos extraídos
 * RELATIVOS à pasta do perfil, pra registrar no manifesto.
 */
function extractConfigZip(zipPath: string, destDir: string, profileRoot: string): string[] {
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(zipPath)
  const base = path.resolve(destDir)
  const written: string[] = []
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const target = path.resolve(base, entry.entryName)
    if (target !== base && !target.startsWith(base + path.sep)) continue // zip slip
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.getData())
    written.push(path.relative(path.resolve(profileRoot), target))
  }
  return written
}

/** Apaga arquivos extraídos por um pacote (e as pastas que ficaram vazias). Best-effort. */
function removeExtractedFiles(profile: string, files: string[]) {
  const root = path.resolve(profileDir(profile))
  const dirs = new Set<string>()
  for (const rel of files) {
    const target = path.resolve(root, rel)
    if (target !== root && !target.startsWith(root + path.sep)) continue
    try { fs.unlinkSync(target) } catch { /* já não existe */ }
    dirs.add(path.dirname(target))
  }
  // Do mais profundo pro mais raso, pra pastas aninhadas vazias também saírem.
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    if (dir === root || !dir.startsWith(root + path.sep)) continue
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir) } catch { /* não vazia / em uso */ }
  }
}

const VALHEIM_APPID = '892970'

/**
 * Executável do jogo na pasta do Valheim.
 *  - `native`  → build Linux do Valheim (valheim.x86_64). Doorstop injeta por LD_PRELOAD.
 *  - `windows` → valheim.exe (Windows, ou depot Windows rodando por Proton no Linux).
 *    Doorstop injeta pelo proxy winhttp.dll.
 * No Linux o nativo tem prioridade: quem tem os dois depots instalados normalmente joga o nativo.
 */
function findGameExecutable(valheimPath: string): { path: string; kind: 'native' | 'windows' } | null {
  if (process.platform !== 'win32') {
    const native = path.join(valheimPath, 'valheim.x86_64')
    if (fs.existsSync(native)) return { path: native, kind: 'native' }
  }
  const win = path.join(valheimPath, 'valheim.exe')
  if (fs.existsSync(win)) return { path: win, kind: 'windows' }
  return null
}

/** Raízes de instalação da Steam no Linux (pacote nativo, flatpak e snap). */
function linuxSteamRoots(): string[] {
  const home = os.homedir()
  return [
    path.join(home, '.steam', 'steam'),
    path.join(home, '.steam', 'root'),
    path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
    path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'),
  ]
}

/**
 * Bibliotecas da Steam no Linux: as raízes conhecidas + as pastas extras declaradas no
 * libraryfolders.vdf. Sem ler o vdf, quem instalou o Valheim num HD/SSD secundário não é detectado.
 */
function linuxSteamLibraries(): string[] {
  const out = new Set<string>()
  for (const root of linuxSteamRoots()) {
    if (!fs.existsSync(root)) continue
    out.add(root)
    const vdfs = [
      path.join(root, 'steamapps', 'libraryfolders.vdf'),
      path.join(root, 'config', 'libraryfolders.vdf'),
    ]
    for (const vdf of vdfs) {
      try {
        const txt = fs.readFileSync(vdf, 'utf8')
        // Formato atual: "path" "<dir>". Formato antigo: "1" "<dir>".
        for (const m of txt.matchAll(/"(?:path|\d+)"\s*"([^"]+)"/g)) out.add(m[1])
      } catch { /* essa raiz não tem vdf */ }
    }
  }
  return [...out]
}

function autoDetectValheim(): string {
  if (process.platform === 'linux') {
    for (const lib of linuxSteamLibraries()) {
      const p = path.join(lib, 'steamapps', 'common', 'Valheim')
      if (findGameExecutable(p)) return p
    }
    return ''
  }
  const possiblePaths = [
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Valheim',
    'C:\\Program Files\\Steam\\steamapps\\common\\Valheim',
    'D:\\Steam\\steamapps\\common\\Valheim',
    'D:\\SteamLibrary\\steamapps\\common\\Valheim',
    'E:\\Steam\\steamapps\\common\\Valheim',
    'E:\\SteamLibrary\\steamapps\\common\\Valheim',
  ]
  for (const p of possiblePaths) {
    if (fs.existsSync(path.join(p, 'valheim.exe'))) return p
  }
  return ''
}

/**
 * Localiza o Steam.exe. Necessário para lançar o jogo COM o Steam (estilo r2modman),
 * passando os args do doorstop no launch — em vez de rodar valheim.exe direto, que na
 * máquina de alguns usuários faz o Valheim se relançar pela Steam e perder o doorstop
 * (abre vanilla, sem terminal). Lê o registro (funciona para qualquer biblioteca do Steam),
 * com fallback derivando do caminho do jogo e dos caminhos fixos.
 */
function findSteamExe(valheimPath: string): string | null {
  const tryReg = (root: string, key: string, val: string): string | null => {
    try {
      const out = execFileSync('reg', ['query', `${root}\\${key}`, '/v', val], {
        encoding: 'utf8',
      })
      const m = out.match(new RegExp(`${val}\\s+REG_SZ\\s+(.+)`, 'i'))
      if (m) {
        const p = path.normalize(m[1].trim())
        // SteamPath aponta para a pasta; SteamExe para o exe.
        const exe = p.toLowerCase().endsWith('.exe') ? p : path.join(p, 'steam.exe')
        if (fs.existsSync(exe)) return exe
      }
    } catch { /* chave ausente / reg indisponível */ }
    return null
  }

  const candidates = [
    () => tryReg('HKCU', 'Software\\Valve\\Steam', 'SteamExe'),
    () => tryReg('HKCU', 'Software\\Valve\\Steam', 'SteamPath'),
    () => tryReg('HKLM', 'SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    () => tryReg('HKLM', 'SOFTWARE\\Valve\\Steam', 'InstallPath'),
    // Fallback: .../Steam/steamapps/common/Valheim -> .../Steam/steam.exe
    () => {
      const guess = path.join(valheimPath, '..', '..', '..', 'steam.exe')
      return fs.existsSync(guess) ? guess : null
    },
  ]
  for (const c of candidates) {
    const hit = c()
    if (hit) return hit
  }
  // Últimos recursos: caminhos fixos comuns.
  for (const p of ['C:\\Program Files (x86)\\Steam\\steam.exe', 'C:\\Program Files\\Steam\\steam.exe']) {
    if (fs.existsSync(p)) return p
  }
  return null
}

/** Comando que abre a Steam no Linux: binário nativo, flatpak ou snap. */
function findSteamLauncherLinux(): { cmd: string; args: string[] } | null {
  const fixed = [
    '/usr/bin/steam',
    '/usr/games/steam',
    '/usr/local/bin/steam',
    path.join(os.homedir(), '.local', 'bin', 'steam'),
    '/snap/bin/steam',
  ]
  for (const p of fixed) {
    if (fs.existsSync(p)) return { cmd: p, args: [] }
  }
  try {
    const hit = execFileSync('which', ['steam'], { encoding: 'utf8' }).trim()
    if (hit) return { cmd: hit, args: [] }
  } catch { /* sem steam no PATH */ }
  try {
    execFileSync('flatpak', ['info', 'com.valvesoftware.Steam'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return { cmd: 'flatpak', args: ['run', 'com.valvesoftware.Steam'] }
  } catch { /* sem flatpak da Steam */ }
  return null
}

/**
 * O cliente da Steam está aberto? No modo modado a gente executa o valheim.x86_64 direto
 * (só assim as variáveis do doorstop chegam ao processo do jogo — ver game:launch), e aí o
 * Steamworks do Valheim precisa de um cliente já rodando para autenticar.
 */
function isSteamRunningLinux(): boolean {
  const home = os.homedir()
  const pidFiles = [
    path.join(home, '.steam', 'steam.pid'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.steam', 'steam.pid'),
    path.join(home, 'snap', 'steam', 'common', '.steam', 'steam.pid'),
  ]
  for (const f of pidFiles) {
    try {
      const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10)
      if (pid > 0 && fs.existsSync(`/proc/${pid}`)) return true
    } catch { /* sem pid file: cai na varredura do /proc */ }
  }
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        if (fs.readFileSync(`/proc/${entry}/comm`, 'utf8').trim() === 'steam') return true
      } catch { /* processo morreu no meio da varredura */ }
    }
  } catch { /* sem /proc (container?) */ }
  return false
}

/** libdoorstop_x64.so do perfil — é o doorstop do Linux (v4), equivalente ao winhttp.dll. */
function findDoorstopLibLinux(profileRoot: string): string | null {
  const dir = path.join(profileRoot, 'doorstop_libs')
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir)
  const preferred = 'libdoorstop_x64.so'
  if (files.includes(preferred)) return path.join(dir, preferred)
  const any = files.find(f => /^libdoorstop.*\.so$/i.test(f))
  return any ? path.join(dir, any) : null
}

/**
 * Caminho Linux → caminho Windows para o Wine/Proton. O prefixo do Proton mapeia Z:\ para /,
 * então /home/user/x vira Z:\home\user\x. Usado só no caso Proton (depot Windows no Linux),
 * onde o doorstop que roda é o winhttp.dll e ele só entende caminho estilo Windows.
 */
function toWinePath(p: string): string {
  return 'Z:' + path.resolve(p).replace(/\//g, '\\')
}

/** Garante o bit de execução no binário do jogo (a Steam normalmente já deixa). */
function ensureExecutable(file: string) {
  try {
    fs.accessSync(file, fs.constants.X_OK)
  } catch {
    try { fs.chmodSync(file, 0o755) } catch { /* sem permissão: o spawn falha com EACCES */ }
  }
}

function loadConfig() {
  ensureDirs()
  if (!fs.existsSync(CONFIG_FILE)) {
    const detected = autoDetectValheim()
    const defaultConfig = {
      valheimPath: detected,
      installedMods: [],
      backendUrl: '',
      modpackRepo: '',
      modpackBranch: 'main',
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2))
    registerConfiguredRoots(defaultConfig)
    return defaultConfig
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
  if (!config.valheimPath) {
    config.valheimPath = autoDetectValheim()
    saveConfig(config)
  }
  registerConfiguredRoots(config)
  return config
}

function saveConfig(newValues: object) {
  ensureDirs()
  let current: any = {}
  if (fs.existsSync(CONFIG_FILE)) {
    current = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
  }
  const merged = { ...current, ...newValues }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2))
  registerConfiguredRoots(merged)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0d1520',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandbox do Chromium: isola o renderer em processo próprio sem acesso ao SO. O preload só
      // usa contextBridge/ipcRenderer (compatíveis com sandbox), então liga sem quebrar a ponte.
      sandbox: true,
    },
  })

  // Em produção carrega o bundle local diretamente. NUNCA tenta o servidor de dev primeiro:
  // um processo qualquer escutando em localhost:5173 na máquina do usuário seria carregado
  // com a ponte IPC (Hofheim) anexada. O dev server só é usado em builds não-empacotados.
  if (app.isPackaged) {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  } else {
    win.loadURL('http://localhost:5173').catch(() => {
      win.loadFile(path.join(__dirname, '../dist/index.html'))
    })
  }

  // Trava de navegação: impede a janela principal de sair da própria origem. Sem isso, se o
  // renderer fosse induzido a navegar para uma página remota, ela herdaria a ponte Hofheim
  // (fs read/write, game.launch). Links externos legítimos passam por shell.openExternal.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}

app.whenReady().then(() => {
  // Content-Security-Policy só em produção (o dev server do Vite usa inline scripts + WS de HMR,
  // que uma CSP estrita quebraria). Restringe scripts à própria origem e conexões/imagens a HTTPS,
  // servindo de rede de segurança contra XSS. Ajuste as fontes se o app passar a buscar outros hosts.
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; " +
            "script-src 'self'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' https: data:; " +
            "font-src 'self' data:; " +
            "connect-src 'self' https:; " +
            "object-src 'none'; " +
            "frame-src 'none'",
          ],
        },
      })
    })
  }

  // Corrige instalações antigas com config/ aninhado dentro de plugins/ (duplicatas).
  migrateAllProfiles()

  const win = createWindow()

  // Auto-updater — only runs in packaged builds.
  // No Linux, só o AppImage suporta atualização in-place (o electron-updater identifica o
  // AppImage pela env APPIMAGE). Num .deb o updater sempre falha e o player veria a barra de
  // erro em toda abertura; nesse caso a atualização é pelo gerenciador de pacotes/download novo.
  const updaterSupported = process.platform !== 'linux' || !!process.env.APPIMAGE

  /**
   * Último status do updater. Existe porque `webContents.send` NÃO enfileira: a checagem começa
   * 3s depois do app pronto e pode terminar antes do React montar e registrar o listener — aí o
   * evento se perde e a barra nunca aparece, sem nenhum sinal de que algo aconteceu. O renderer
   * lê este estado ao montar (`updater:getStatus`) e recupera o que perdeu.
   */
  let lastUpdaterStatus: { status: string; message?: string; version?: string } | null = null

  function sendUpdaterStatus(payload: { status: string; message?: string; version?: string }) {
    lastUpdaterStatus = payload
    logUpdater(`status=${payload.status}${payload.version ? ` version=${payload.version}` : ''}${payload.message ? ` — ${payload.message}` : ''}`)
    try { win.webContents.send('updater:status', payload) } catch { /* janela fechou */ }
  }

  if (app.isPackaged && updaterSupported) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('update-available', (info) => {
      sendUpdaterStatus({ status: 'available', version: info?.version })
    })

    // Sem este evento não havia como dizer "você já está na última versão": quando não há
    // atualização o electron-updater não emite mais nada, e a ausência de barra era idêntica
    // a uma checagem que falhou ou a um evento perdido.
    autoUpdater.on('update-not-available', (info) => {
      sendUpdaterStatus({ status: 'not-available', version: info?.version })
    })

    autoUpdater.on('download-progress', (info) => {
      win.webContents.send('updater:progress', {
        percent: Math.round(info.percent),
        transferred: info.transferred,
        total: info.total,
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      sendUpdaterStatus({ status: 'downloaded', version: info?.version })
    })

    autoUpdater.on('error', (err) => {
      console.error('Auto-updater error:', err)
      sendUpdaterStatus({ status: 'error', message: err.message })
    })

    logUpdater(`app ${app.getVersion()} — checagem automática agendada (plataforma ${process.platform})`)
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(err => logUpdater(`checkForUpdates falhou: ${describeDownloadError(err)}`))
    }, 3000)
  } else {
    logUpdater(`updater inativo: packaged=${app.isPackaged} supported=${updaterSupported} (app ${app.getVersion()})`)
  }

  /** Estado do app para a tela Sobre: versão instalada e se o updater pode rodar aqui. */
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    updaterSupported,
    platform: process.platform,
  }))

  /** Último status conhecido, para o renderer não perder o que foi emitido antes de montar. */
  ipcMain.handle('updater:getStatus', () => lastUpdaterStatus)

  /**
   * Checagem manual. Diferente da automática, RESPONDE o resultado — sem isso um clique em
   * "Verificar atualizações" que não encontra nada (ou que falha) não dava retorno nenhum.
   */
  ipcMain.handle('updater:check', async () => {
    const version = app.getVersion()
    if (!app.isPackaged) return { success: false, reason: 'dev', version }
    if (!updaterSupported) return { success: false, reason: 'unsupported', version }
    try {
      const result = await autoUpdater.checkForUpdates()
      return { success: true, version, latestVersion: result?.updateInfo?.version }
    } catch (err: any) {
      logUpdater(`checagem manual falhou: ${describeDownloadError(err)}`)
      return { success: false, reason: 'error', error: friendlyUpdaterError(err), version }
    }
  })

  ipcMain.handle('updater:install', () => {
    if (app.isPackaged && updaterSupported) autoUpdater.quitAndInstall()
  })

  ipcMain.on('window:minimize', () => win.minimize())
  ipcMain.on('window:maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize())
  ipcMain.on('window:close', () => win.close())

  ipcMain.handle('config:load', () => loadConfig())

  ipcMain.handle('config:save', (_e, newValues) => {
    console.log('config:save recebido:', JSON.stringify(newValues))
    saveConfig(newValues)
    return true
  })

  ipcMain.handle('valheim:autoDetect', () => autoDetectValheim())

  ipcMain.handle('mods:defaultPath', () => PROFILES_ROOT)

  ipcMain.handle('dialog:selectValheimPath', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Selecione a pasta do Valheim',
      properties: ['openDirectory'],
    })
    if (!result.canceled && result.filePaths[0]) {
      allowedFsRoots.add(path.resolve(result.filePaths[0]))
      return result.filePaths[0]
    }
    return null
  })

  ipcMain.handle('mods:install', async (_e, { zipPath, modName, profile }) => {
    try {
      ensureDirs(profile)
      // Sanitiza o nome do mod: ele vira segmento de caminho (plugins/<mod>) e vem do manifesto.
      // Sem isso, um nome com `../` gravaria fora do perfil (path traversal).
      const mod = safeName(modName)
      const ext = path.extname(zipPath).toLowerCase()
      const modFolder = path.join(profileDir(profile), 'BepInEx', 'plugins', mod)

      if (ext === '.dll' || ext === '.mdb') {
        // DLL (ou .mdb, símbolos de debug Mono que acompanham a dll): copia direto na pasta
        // de plugin do mod para o BepInEx achar. O .mdb precisa ficar ao lado da sua dll.
        fs.mkdirSync(modFolder, { recursive: true })
        fs.copyFileSync(zipPath, path.join(modFolder, path.basename(zipPath)))
        // Sem arquivos em pastas compartilhadas: manifesto vazio (remoção só apaga o plugin).
        writeModManifest(profileDir(profile), mod, [])
      } else {
        // ZIP (default): extract to a staging dir first, then route the package the same
        // way r2modman does — special top-level folders (config/, patchers/, monomod/,
        // core/, plugins/) go to their BepInEx locations instead of being dumped inside
        // plugins/<modName>/.
        const AdmZip = require('adm-zip')
        const zip = new AdmZip(zipPath)
        const staging = path.join(os.tmpdir(), `Hofheim-mod-${mod}-${Date.now()}`)
        zip.extractAllTo(staging, true)

        // Detect BepInExPack: ZIP contains winhttp.dll → promote ALL framework files to profile root.
        // R2ModManager copies winhttp.dll, doorstop_config.ini, doorstop_libs/, BepInEx/core/, etc.
        // to the profile root, then does NOT keep BepInExPack in plugins/.
        const winhttpInStaging = findFileInDir(staging, 'winhttp.dll')
        if (winhttpInStaging) {
          // Copy everything at the BepInExPack root level to the profile root
          // (winhttp.dll, doorstop_config.ini, doorstop_libs/, BepInEx/core/, etc.)
          copyDirRecursive(path.dirname(winhttpInStaging), profileDir(profile))
        } else {
          // Normal Thunderstore mod: route config/ → BepInEx/config/, etc.
          const external = routeModContents(staging, profileDir(profile), mod)
          // Registra os arquivos roteados p/ pastas compartilhadas para o mods:remove limpá-los.
          writeModManifest(profileDir(profile), mod, external)
        }
        // Limpeza do staging é BEST-EFFORT: nesse ponto a extração + roteamento já terminaram
        // com sucesso, então uma falha ao apagar o temp NÃO pode abortar o install. No Windows,
        // apagar %LOCALAPPDATA%\Temp\... dá ENOTEMPTY/EBUSY/EPERM quando antivírus/indexador ainda
        // segura um handle; maxRetries faz o Node retentar, e o catch evita que sobre (o SO limpa o Temp).
        try {
          fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        } catch { /* temp órfão no %TEMP%; o mod já está instalado, o SO recolhe depois */ }
      }

      fs.unlinkSync(zipPath)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('mods:download', async (_e, { url, modName, headers, sha256 }: { url: string; modName: string; headers?: Record<string, string>; sha256?: string }) => {
    try {
      // Só baixa de http/https (bloqueia file:// e outros esquemas vindos do renderer).
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        return { success: false, error: 'URL de download inválida' }
      }
      // Ordem das rotas: a preferida primeiro, a outra como plano B. Quando o ambiente do player
      // quebra uma delas (antivírus interceptando HTTPS derruba o node), a preferência já vem
      // trocada e os mods seguintes não repetem os ~4s de retry inútil — ver preferredRoute.
      const [first, second] = preferredRoute === 'chromium'
        ? [downloadViaChromiumRoute, downloadViaNodeRoute]
        : [downloadViaNodeRoute, downloadViaChromiumRoute]

      let buf: Buffer | undefined
      let lastErr: any
      try {
        buf = await first(url, modName, headers)
      } catch (err: any) {
        lastErr = err
        // Plano B só para falha de TRANSPORTE: 404 é 404 pelas duas rotas, trocar não ajuda.
        if (isNetworkishError(err)) {
          try {
            buf = await second(url, modName, headers)
            // Deu certo pela outra rota: a preferida está quebrada NESTE ambiente. Fixa a troca
            // para o resto da sessão — o próximo mod já começa pela que funciona.
            const winner = first === downloadViaNodeRoute ? 'chromium' : 'node'
            if (preferredRoute !== winner) {
              preferredRoute = winner
              logDownloadIssue(`rota de download trocada para "${winner}" pelo resto da sessão (a anterior falhou em ${modName})`)
            }
          } catch (err2: any) {
            // Reporta o erro mais informativo dos dois: um HTTP status diz mais que um socket morto.
            lastErr = err2?.response?.status ? err2 : err
          }
        }
      }

      if (!buf) {
        const msg = friendlyDownloadError(lastErr, modName)
        logDownloadIssue(`${modName}: DESISTINDO — url=${url.split('?')[0]} — ${describeDownloadError(lastErr)}`)
        return { success: false, error: msg }
      }

      // Verificação de integridade (defense-in-depth): se o manifesto trouxer um sha256, o
      // download só é aceito se o hash bater. Protege contra um repositório/mirror adulterado.
      // Retrocompatível: mods sem sha256 no manifesto seguem sem verificação.
      if (sha256) {
        const digest = crypto.createHash('sha256').update(buf).digest('hex')
        if (digest.toLowerCase() !== String(sha256).toLowerCase()) {
          return { success: false, error: `Integridade falhou para ${modName}: hash não confere (esperado ${sha256}, obtido ${digest}).` }
        }
      }

      // Preserve the real file extension so mods:install can detect the file type
      const urlExt = path.extname(url.split('?')[0]).toLowerCase() || '.zip'
      const tempPath = path.join(os.tmpdir(), `${safeName(modName)}-${Date.now()}${urlExt}`)
      fs.writeFileSync(tempPath, buf)
      return { success: true, tempPath }
    } catch (err: any) {
      return { success: false, error: friendlyDownloadError(err, modName) }
    }
  })

  ipcMain.handle('mods:pickModFile', async () => {
    // Escolhe o arquivo do mod SEM lê-lo (mods grandes não cabem via IPC). Guarda o
    // caminho num token opaco e devolve só metadados — o upload usa o token.
    const result = await dialog.showOpenDialog(win, {
      title: 'Selecione o arquivo do mod (.zip / .dll / .mdb)',
      filters: [{ name: 'Arquivos de Mod', extensions: ['zip', 'dll', 'mdb'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const filePath = result.filePaths[0]
    let size: number
    try { size = fs.statSync(filePath).size } catch { return null }
    const token = crypto.randomUUID()
    pickedModFiles.set(token, filePath)
    return { token, filename: path.basename(filePath), size }
  })

  ipcMain.handle('mods:uploadPrivateModStream', async (
    _e,
    { token, backendUrl, authToken }: { token: string; backendUrl: string; authToken: string },
  ) => {
    // Sobe o mod pro R2 SEMPRE via Worker (multipart), em partes de 25MiB. O app não
    // fala com o R2 direto — cada parte vai autenticada pro Worker, que repassa ao R2.
    // Funciona pra mods de qualquer tamanho (300MB+). Emite progresso em mods:uploadProgress.
    const filePath = pickedModFiles.get(token)
    if (!filePath) return { success: false, error: 'Arquivo não encontrado (selecione de novo)' }
    if (typeof backendUrl !== 'string' || !/^https?:\/\//i.test(backendUrl)) {
      return { success: false, error: 'Backend inválido' }
    }
    const base = backendUrl.replace(/\/+$/, '')
    const filename = path.basename(filePath)
    if (!/^[^/\\]+\.(dll|zip|mdb)$/i.test(filename)) {
      return { success: false, error: 'Apenas .dll, .zip e .mdb são permitidos' }
    }
    const axios = require('axios')
    const auth = { Authorization: `Bearer ${authToken}` }
    let uploadId = ''
    let fd: number | null = null
    try {
      const total = fs.statSync(filePath).size

      const created = await axios.post(`${base}/mods/private/multipart/create`, { filename }, { headers: auth, timeout: 30000 })
      uploadId = created.data?.uploadId
      if (!uploadId) throw new Error('Backend não devolveu uploadId')

      fd = fs.openSync(filePath, 'r')
      const parts: { partNumber: number; etag: string }[] = []
      const buffer = Buffer.allocUnsafe(MOD_UPLOAD_PART_SIZE)
      let position = 0
      let partNumber = 0
      while (position < total) {
        const bytesRead = fs.readSync(fd, buffer, 0, MOD_UPLOAD_PART_SIZE, position)
        if (bytesRead <= 0) break
        partNumber++
        const chunk = buffer.subarray(0, bytesRead)
        const q = `filename=${encodeURIComponent(filename)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`
        const res = await axios.put(`${base}/mods/private/multipart/part?${q}`, chunk, {
          headers: { ...auth, 'Content-Type': 'application/octet-stream' },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 300000,
        })
        parts.push({ partNumber, etag: res.data.etag })
        position += bytesRead
        try { win.webContents.send('mods:uploadProgress', { filename, sent: position, total }) } catch { /* janela pode ter fechado */ }
      }

      await axios.post(`${base}/mods/private/multipart/complete`, { filename, uploadId, parts }, { headers: auth, timeout: 60000 })
      uploadId = '' // completado — não abortar no finally
      return { success: true, filename, downloadUrl: `/mods/private/${filename}` }
    } catch (err: any) {
      if (uploadId) {
        try { await axios.post(`${base}/mods/private/multipart/abort`, { filename, uploadId }, { headers: auth, timeout: 15000 }) } catch { /* best-effort */ }
      }
      return { success: false, error: err?.response?.data?.error || err?.message || 'Falha no upload' }
    } finally {
      if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
      pickedModFiles.delete(token)
    }
  })

  ipcMain.handle('configs:pickZip', async () => {
    // Escolhe um pacote de configs (.zip — ex.: texturas) SEM lê-lo: zips de textura têm
    // dezenas/centenas de MB e não cabem via IPC. Mesmo esquema de token opaco do
    // mods:pickModFile — o renderer nunca vê o caminho absoluto.
    const result = await dialog.showOpenDialog(win, {
      title: 'Selecione o pacote de configs (.zip)',
      filters: [{ name: 'Pacote ZIP', extensions: ['zip'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const filePath = result.filePaths[0]
    let size: number
    try { size = fs.statSync(filePath).size } catch { return null }
    // Valida que é um ZIP legível ANTES de subir dezenas de MB (e conta as entradas
    // pra o admin conferir na UI que pegou o pacote certo).
    let entries: number
    try {
      const AdmZip = require('adm-zip')
      entries = new AdmZip(filePath).getEntries().filter((e: any) => !e.isDirectory).length
    } catch {
      return { error: 'Arquivo não é um ZIP válido' }
    }
    const token = crypto.randomUUID()
    pickedModFiles.set(token, filePath)
    return { token, filename: path.basename(filePath), size, entries }
  })

  ipcMain.handle('configs:uploadZipStream', async (
    _e,
    { token, backendUrl, authToken }: { token: string; backendUrl: string; authToken: string },
  ) => {
    // Sobe o pacote de configs pro R2 via Worker (multipart, partes de 25MiB), igual ao
    // upload de mod privado. O /configs/upload comum manda o arquivo TODO em base64 e
    // não serve pra zip de texturas. O hash sha256 vai junto: o Worker usa os 8 primeiros
    // chars na key (content-addressed), então trocar o zip muda a URL e o launcher reaplica.
    const filePath = pickedModFiles.get(token)
    if (!filePath) return { success: false, error: 'Arquivo não encontrado (selecione de novo)' }
    if (typeof backendUrl !== 'string' || !/^https?:\/\//i.test(backendUrl)) {
      return { success: false, error: 'Backend inválido' }
    }
    const base = backendUrl.replace(/\/+$/, '')
    const original = path.basename(filePath)
    if (!/\.zip$/i.test(original)) return { success: false, error: 'Apenas .zip é aceito aqui' }
    // O backend exige key simples (^[A-Za-z0-9._-]+\.zip$): troca espaço/acento por `_`.
    const filename = original.replace(/[^A-Za-z0-9._-]+/g, '_')

    const axios = require('axios')
    const auth = { Authorization: `Bearer ${authToken}` }
    let uploadId = ''
    let sha256 = ''
    let fd: number | null = null
    try {
      const total = fs.statSync(filePath).size

      // sha256 dos bytes, em streaming (não carrega o arquivo na memória).
      sha256 = await new Promise<string>((resolve, reject) => {
        const h = crypto.createHash('sha256')
        const rs = fs.createReadStream(filePath)
        rs.on('data', chunk => h.update(chunk))
        rs.on('error', reject)
        rs.on('end', () => resolve(h.digest('hex')))
      })

      const created = await axios.post(
        `${base}/configs/multipart/create`,
        { filename, sha256 },
        { headers: auth, timeout: 30000 },
      )
      uploadId = created.data?.uploadId
      if (!uploadId) throw new Error('Backend não devolveu uploadId')

      fd = fs.openSync(filePath, 'r')
      const parts: { partNumber: number; etag: string }[] = []
      const buffer = Buffer.allocUnsafe(MOD_UPLOAD_PART_SIZE)
      let position = 0
      let partNumber = 0
      while (position < total) {
        const bytesRead = fs.readSync(fd, buffer, 0, MOD_UPLOAD_PART_SIZE, position)
        if (bytesRead <= 0) break
        partNumber++
        const q =
          `filename=${encodeURIComponent(filename)}&sha256=${sha256}` +
          `&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`
        const res = await axios.put(`${base}/configs/multipart/part?${q}`, buffer.subarray(0, bytesRead), {
          headers: { ...auth, 'Content-Type': 'application/octet-stream' },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 300000,
        })
        parts.push({ partNumber, etag: res.data.etag })
        position += bytesRead
        try { win.webContents.send('configs:uploadProgress', { filename: original, sent: position, total }) } catch { /* janela pode ter fechado */ }
      }

      const done = await axios.post(
        `${base}/configs/multipart/complete`,
        { filename, sha256, uploadId, parts },
        { headers: auth, timeout: 60000 },
      )
      uploadId = '' // completado — não abortar no finally
      const url = done.data?.url || `${base}/configs/${sha256.slice(0, 8)}-${filename}`
      return { success: true, filename: original, url, sha256 }
    } catch (err: any) {
      if (uploadId) {
        try {
          await axios.post(`${base}/configs/multipart/abort`, { filename, sha256, uploadId }, { headers: auth, timeout: 15000 })
        } catch { /* best-effort */ }
      }
      return { success: false, error: err?.response?.data?.error || err?.message || 'Falha no upload' }
    } finally {
      if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
      pickedModFiles.delete(token)
    }
  })

  // Sobe UM config do disco pro R2 via Worker, em PUT único com o corpo STREAMADO.
  // Substitui o antigo fs:readFileBase64 + POST /configs/upload, que trazia o arquivo
  // inteiro em base64 pro renderer e mandava dentro de um JSON: o Worker segurava ~6
  // cópias do arquivo por request e, como os 128MB dele são por isolate (divididos
  // entre TODOS os uploads em voo), subir um modpack com muitas configs derrubava o
  // Worker com "exceeded memory limit". Aqui os bytes vão direto do disco pro socket.
  //
  // O arquivo é lido duas vezes, sempre em streaming: a 1ª pro sha256 (que precisa ir
  // na query ANTES do corpo começar) e a 2ª como corpo. Memória constante nas duas.
  ipcMain.handle('configs:uploadFileStream', async (
    _e,
    { filePath, filename, backendUrl, authToken }:
      { filePath: string; filename: string; backendUrl: string; authToken: string },
  ) => {
    if (typeof backendUrl !== 'string' || !/^https?:\/\//i.test(backendUrl)) {
      return { success: false, error: 'Backend inválido' }
    }
    // Mesmo confinamento de caminho do fs:readFileBase64, que esta rota substitui.
    if (!isPathAllowed(filePath)) return { success: false, error: 'Acesso negado a este arquivo' }
    // A key do R2 é um segmento só; barra aqui viraria path traversal no bucket.
    if (!filename || /[/\\]/.test(filename) || filename.includes('..')) {
      return { success: false, error: 'Nome de config inválido' }
    }
    const base = backendUrl.replace(/\/+$/, '')
    const axios = require('axios')
    try {
      const total = fs.statSync(filePath).size
      // Config vazio zeraria o do player quando aplicado — mesma regra do fluxo de texto.
      if (total === 0) return { success: false, error: 'Arquivo vazio' }
      if (total > CONFIG_SINGLE_PUT_MAX) {
        return {
          success: false,
          error: `Config grande demais para envio único (${(total / 1024 / 1024).toFixed(1)} MB). Empacote como .zip e use o upload de pacote.`,
        }
      }

      // sha256 dos bytes, em streaming (não carrega o arquivo na memória).
      const sha256 = await new Promise<string>((resolve, reject) => {
        const h = crypto.createHash('sha256')
        const rs = fs.createReadStream(filePath)
        rs.on('data', chunk => h.update(chunk))
        rs.on('error', reject)
        rs.on('end', () => resolve(h.digest('hex')))
      })

      const q = `filename=${encodeURIComponent(filename)}&sha256=${sha256}`
      const res = await axios.put(`${base}/configs/upload?${q}`, fs.createReadStream(filePath), {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/octet-stream',
          // OBRIGATÓRIO: com um stream no corpo o Node usaria Transfer-Encoding: chunked,
          // e o R2 recusa gravar de stream sem tamanho conhecido ("Provided readable
          // stream must have a known length") — o Worker devolve 411 nesse caso.
          'Content-Length': String(total),
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 300000,
      })
      const url = res.data?.url || `${base}/configs/${sha256.slice(0, 8)}-${filename}`
      return { success: true, url, sha256 }
    } catch (err: any) {
      return { success: false, error: err?.response?.data?.error || err?.message || 'Falha no upload' }
    }
  })

  ipcMain.handle('mods:applyConfig', async (_e, { profile, installPath, content }) => {
    try {
      ensureDirs(profile)
      const target = resolveConfigTarget(profile, installPath)
      if (!target) return { success: false, error: 'Caminho de config inválido' }
      await writeConfigToDisk(target, content)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Aplica TODOS os configs do modpack de uma vez, de forma INCREMENTAL: pula os que não
  // mudaram (hash) e cujo arquivo ainda existe no disco. Substitui o loop de N chamadas
  // mods:applyConfig no renderer (N round-trips de IPC + N downloads do R2 a cada launch).
  // Num relaunch sem mudanças, pula tudo instantaneamente — nada é reescrito nem rebaixado.
  ipcMain.handle('mods:applyConfigs', async (
    _e,
    { profile, configs }: { profile: string; configs: { installPath: string; content: string; filename?: string; extract?: boolean }[] },
  ) => {
    try {
      ensureDirs(profile)
      const all = Array.isArray(configs) ? configs : []
      // Pacotes .zip (extract: true) seguem um caminho próprio: baixam, extraem e registram
      // os arquivos gerados. Os demais são arquivo-a-arquivo, como sempre.
      const list = all.filter(c => !c.extract)
      const zipPacks = all.filter(c => !!c.extract)
      const total = all.length
      const applied = readAppliedConfigs(profile)
      const wanted = new Set<string>()
      let done = 0, appliedCount = 0, skipped = 0
      // `failed` = falha TRANSITÓRIA (download/gravação): vale tentar de novo, e é o que faz o
      // renderer não marcar os configs como aplicados. `invalid` = entrada quebrada no modpack
      // (installPath fora do perfil, url de pacote inválida): nenhuma nova tentativa resolve, então
      // não pode bloquear o marcador — senão o launcher reaplicaria tudo em TODO launch pra sempre.
      const failed: string[] = []
      const invalid: string[] = []

      // Separa o que precisa aplicar (hash mudou OU arquivo sumiu — auto-cura remoções manuais)
      // do que pode ser pulado. Já contabiliza os pulados no progresso.
      const pending: { installPath: string; content: string; filename?: string; hash: string; target: string }[] = []
      for (const c of list) {
        wanted.add(c.installPath)
        const target = resolveConfigTarget(profile, c.installPath)
        if (!target) { invalid.push(c.installPath); done++; continue }
        const hash = hashConfigEntry(c.installPath, c.content)
        if (applied[c.installPath] === hash && fs.existsSync(target)) {
          skipped++; done++; continue
        }
        pending.push({ installPath: c.installPath, content: c.content, filename: c.filename, hash, target })
      }
      try { win.webContents.send('mods:applyConfigProgress', { done, total, filename: '' }) } catch { /* janela fechou */ }

      // Aplica os pendentes com concorrência limitada — os downloads do R2 em paralelo aceleram
      // muito o primeiro apply (centenas de URLs). Grava o registro a cada 25 para ser resiliente
      // a interrupção (fechar o launcher no meio não obriga a refazer tudo no próximo launch).
      let idx = 0, sinceSave = 0
      async function worker() {
        while (idx < pending.length) {
          const p = pending[idx++]
          try {
            await writeConfigToDisk(p.target, p.content)
            applied[p.installPath] = p.hash
            appliedCount++
          } catch { failed.push(p.installPath) }
          done++; sinceSave++
          if (sinceSave >= 25) { sinceSave = 0; try { writeAppliedConfigs(profile, applied) } catch { /* segue */ } }
          try { win.webContents.send('mods:applyConfigProgress', { done, total, filename: p.filename || p.installPath }) } catch { /* janela fechou */ }
        }
      }
      await Promise.all(Array.from({ length: Math.min(8, pending.length) }, worker))

      // Remove do registro os configs que não estão mais no modpack (mantém o arquivo no disco,
      // como o r2modman — só deixa de rastreá-los).
      for (const k of Object.keys(applied)) if (!wanted.has(k)) delete applied[k]
      writeAppliedConfigs(profile, applied)

      // ── Pacotes .zip: baixa e extrai no perfil ────────────────────────────────────
      // Um por vez (são grandes) e só quando mudou: a URL do R2 é content-addressed, então
      // o hash muda quando o admin sobe outro zip. Se algum arquivo extraído tiver sumido do
      // disco, reextrai (auto-cura, igual aos configs de arquivo único).
      const zipsApplied = readAppliedZips(profile)
      const wantedZips = new Set<string>()
      const profileRoot = profileDir(profile)
      for (const pack of zipPacks) {
        const key = zipEntryKey(pack.installPath, pack.filename)
        wantedZips.add(key)
        const destDir = resolveConfigTarget(profile, pack.installPath || 'BepInEx/config')
        const url = (pack.content || '').trim()
        if (!destDir || !/^https?:\/\//i.test(url)) {
          invalid.push(pack.filename || pack.installPath); done++
          try { win.webContents.send('mods:applyConfigProgress', { done, total, filename: pack.filename || pack.installPath }) } catch { /* janela fechou */ }
          continue
        }
        const hash = hashConfigEntry(key, url)
        const prev = zipsApplied[key]
        if (prev?.hash === hash && prev.files.every(f => fs.existsSync(path.join(profileRoot, f)))) {
          skipped++; done++
          try { win.webContents.send('mods:applyConfigProgress', { done, total, filename: pack.filename || pack.installPath }) } catch { /* janela fechou */ }
          continue
        }
        let tempZip = ''
        try {
          // Avisa ANTES de baixar: um pacote de texturas pode ter centenas de MB e levar
          // minutos — sem isso a UI ficaria parada no mesmo "x/y" e pareceria travada.
          try {
            win.webContents.send('mods:applyConfigProgress', {
              done, total, filename: pack.filename || pack.installPath, stage: 'zip',
            })
          } catch { /* janela fechou */ }
          tempZip = await downloadToTempFile(url, pack.filename || 'config-pack')
          const files = extractConfigZip(tempZip, destDir, profileRoot)
          // Arquivos da versão ANTERIOR do pacote que não vieram na nova: saem do perfil.
          if (prev) {
            const kept = new Set(files)
            removeExtractedFiles(profile, prev.files.filter(f => !kept.has(f)))
          }
          zipsApplied[key] = { hash, files }
          writeAppliedZips(profile, zipsApplied)
          appliedCount++
        } catch {
          failed.push(pack.filename || pack.installPath)
        } finally {
          if (tempZip) { try { fs.unlinkSync(tempZip) } catch { /* ignore */ } }
          done++
          try { win.webContents.send('mods:applyConfigProgress', { done, total, filename: pack.filename || pack.installPath }) } catch { /* janela fechou */ }
        }
      }

      // Pacote removido do modpack: aqui APAGAMOS os arquivos extraídos (diferente dos configs
      // de arquivo único, que ficam no disco). Um pacote de texturas tirado do modpack precisa
      // sair do perfil do player — senão as texturas antigas continuariam valendo pra sempre.
      let zipsChanged = false
      for (const k of Object.keys(zipsApplied)) {
        if (wantedZips.has(k)) continue
        removeExtractedFiles(profile, zipsApplied[k].files)
        delete zipsApplied[k]
        zipsChanged = true
      }
      if (zipsChanged) writeAppliedZips(profile, zipsApplied)

      // Log das falhas: sem isto, "configs demorando/faltando" na máquina de um player não tem
      // como ser diagnosticado remotamente — só aparece o contador na UI.
      if (failed.length || invalid.length) {
        logDownloadIssue(
          `applyConfigs(${profile}): ${failed.length} falha(s) de download, ${invalid.length} entrada(s) inválida(s)` +
          ` — ${[...failed, ...invalid].slice(0, 20).join(', ')}`,
        )
      }
      return { success: true, total, applied: appliedCount, skipped, failed: failed.length, invalid: invalid.length }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('fs:pickImage', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Selecionar imagem',
      filters: [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const filePath = result.filePaths[0]
    const stat = fs.statSync(filePath)
    const content = fs.readFileSync(filePath).toString('base64')
    return {
      filename: path.basename(filePath),
      content,
      size: stat.size,
    }
  })

  ipcMain.handle('mods:pickAndRead', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Selecione o arquivo do mod',
      filters: [
        { name: 'Arquivos de Mod', extensions: ['zip', 'dll'] },
        { name: 'Todos os arquivos', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const filePath = result.filePaths[0]
    const stat = fs.statSync(filePath)
    const content = fs.readFileSync(filePath).toString('base64')
    return {
      filename: path.basename(filePath),
      content,
      size: stat.size,
    }
  })

  ipcMain.handle('mods:readConfigsFromZip', async (_e, { url }: { url: string }) => {
    try {
      // Só busca de http/https (bloqueia file:// e outros esquemas locais vindos do renderer),
      // igual ao mods:download — a url pode vir de dados remotos (manifesto do modpack).
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        return { success: false, error: 'URL inválida' }
      }
      const axios = require('axios')
      const AdmZip = require('adm-zip')
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        maxRedirects: 5,
        timeout: 30000,
      })
      const zip = new AdmZip(Buffer.from(response.data))
      const found: { filename: string; installPath: string; content: string }[] = []
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue
        const name = entry.entryName.replace(/\\/g, '/')
        if (!name.endsWith('.cfg')) continue
        // Preserva a estrutura relativa a uma pasta config/ (ex.: config/Sub/x.cfg →
        // BepInEx/config/Sub/x.cfg). Assim o config casa com onde o mod realmente instala,
        // sem gerar cópia duplicada num caminho achatado. Fora de config/, vai pra raiz.
        const idx = name.indexOf('config/')
        const rel = idx >= 0 ? name.slice(idx + 'config/'.length) : path.posix.basename(name)
        if (!rel || rel.includes('..')) continue
        const installPath = `BepInEx/config/${rel}`
        try {
          const content = entry.getData().toString('utf-8')
          found.push({ filename: path.posix.basename(rel), installPath, content })
        } catch {
          // Skip unreadable entries
        }
      }
      return { success: true, configs: found }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('mods:bepinexOk', (_e, { profile }: { profile: string }) => {
    const dll = path.join(profileDir(profile), 'BepInEx', 'core', 'BepInEx.dll')
    return fs.existsSync(dll)
  })

  ipcMain.handle('mods:openLog', async (_e, { valheimPath, profile }: { valheimPath: string; profile?: string }) => {
    try {
      // No modelo r2modman o BepInEx roda a partir do perfil, então o LogOutput.log fica lá.
      // Ordem: log do BepInEx no perfil → log do BepInEx no jogo (instalações antigas por cópia)
      // → output_log.txt bruto do Unity (redirect_output_log) para crashes precoces.
      const candidates: string[] = []
      if (profile) candidates.push(path.join(profileDir(profile), 'BepInEx', 'LogOutput.log'))
      if (valheimPath) {
        candidates.push(path.join(valheimPath, 'BepInEx', 'LogOutput.log'))
        candidates.push(path.join(valheimPath, 'output_log.txt'))
      }
      const logPath = candidates.find(p => fs.existsSync(p))
      if (!logPath) {
        return { success: false, error: 'Nenhum log encontrado ainda. Jogue no modo modado pelo menos uma vez.' }
      }
      const err = await shell.openPath(logPath)
      if (err) return { success: false, error: err }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('mods:list', (_e, profile: string) => {
    const pluginsPath = path.join(profileDir(profile), 'BepInEx', 'plugins')
    if (!fs.existsSync(pluginsPath)) return []
    return fs.readdirSync(pluginsPath).filter(f =>
      fs.statSync(path.join(pluginsPath, f)).isDirectory()
    )
  })

  ipcMain.handle('mods:remove', (_e, { modName, profile }) => {
    const profileRoot = profileDir(profile)
    const modPath = path.join(profileRoot, 'BepInEx', 'plugins', safeName(modName))
    const existed = fs.existsSync(modPath)
    if (existed) fs.rmSync(modPath, { recursive: true, force: true })

    // Além do plugin, apaga o que o mod roteou para pastas compartilhadas (patchers/monomod/core),
    // registrado no manifesto do install. Sem isso, um patcher removido continua carregando no jogo.
    // Configs não entram no manifesto — preservados de propósito, como no r2modman.
    const mf = modManifestPath(profileRoot, modName)
    let removedExternal = 0
    if (fs.existsSync(mf)) {
      try {
        const { external = [] } = JSON.parse(fs.readFileSync(mf, 'utf-8')) as { external?: string[] }
        const bepinex = path.join(profileRoot, 'BepInEx')
        for (const rel of external) {
          // Segurança: só apaga dentro do perfil (bloqueia path traversal em manifesto adulterado).
          const target = path.resolve(profileRoot, rel)
          if (target !== profileRoot && !target.startsWith(path.resolve(profileRoot) + path.sep)) continue
          if (fs.existsSync(target)) {
            fs.rmSync(target, { force: true })
            removedExternal++
            pruneEmptyParents(target, bepinex)
          }
        }
        fs.rmSync(mf, { force: true })
      } catch { /* manifesto corrompido: plugin já foi removido, segue o jogo */ }
    }

    if (existed || removedExternal > 0) return { success: true }
    return { success: false, error: 'Mod não encontrado' }
  })

  // Apaga o perfil inteiro (pasta do modpack) para forçar uma reinstalação limpa do zero.
  // Usado quando a instalação corrompe/falha no meio: em vez de mandar o jogador apagar a pasta
  // na mão, o botão "reinstalar do zero" chama isto e depois refaz o install completo.
  //
  // A remoção precisa ser CONFIRMADA. O rmSync recursivo falha no meio com EBUSY/EPERM/ENOTEMPTY
  // quando o antivírus/indexador (ou o próprio jogo aberto) ainda segura o handle de uma dll do
  // perfil — sem retry e sem conferir o resultado, o botão dizia "pronto" com a pasta pela metade
  // e o jogador seguia com a versão velha do mod (só apagar a pasta na mão resolvia). Por isso:
  // retry, plano B por rename (tira do caminho mesmo com handle aberto) e erro explícito no fim.
  ipcMain.handle('mods:removeProfile', (_e, profile: string) => {
    try {
      const profileRoot = profileDir(profile)
      // Segurança: só apaga dentro da raiz de perfis (bloqueia id adulterado com path traversal).
      const root = path.resolve(getProfilesRoot())
      const resolved = path.resolve(profileRoot)
      if (resolved === root || !resolved.startsWith(root + path.sep)) {
        return { success: false, error: 'Caminho de perfil inválido' }
      }

      sweepProfileTrash(root)
      if (!fs.existsSync(resolved)) return { success: true, path: resolved }

      const hardRemove = (p: string) =>
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })

      try {
        hardRemove(resolved)
      } catch (err: any) {
        // Plano B: renomeia a pasta para fora do caminho ativo (funciona mesmo com arquivo em uso
        // dentro dela) e tenta apagar o lixo. Mesmo que a limpeza falhe, o caminho do perfil está
        // livre para ser recriado do zero — que é o que o botão promete.
        const trash = path.join(root, `.trash-${path.basename(resolved)}-${Date.now()}`)
        try {
          fs.renameSync(resolved, trash)
        } catch {
          return {
            success: false,
            error: `Não foi possível apagar a pasta do profile (${resolved}). Feche o Valheim e tente de novo. Detalhe: ${err.message}`,
          }
        }
        try { hardRemove(trash) } catch { console.warn('[removeProfile] lixo pendente em', trash) }
      }

      // Confere de fato: só respondemos sucesso se a pasta sumiu do disco.
      if (fs.existsSync(resolved)) {
        return {
          success: false,
          error: `A pasta do profile continua no disco após a remoção (${resolved}). Feche o Valheim e tente de novo.`,
        }
      }
      console.log('[removeProfile] perfil apagado:', resolved)
      return { success: true, path: resolved }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Liga/desliga um mod opcional MOVENDO os arquivos (estilo r2modman), sem apagar/re-baixar.
  ipcMain.handle('mods:setOptionalEnabled', (_e, { profile, modName, enabled, version }: { profile: string; modName: string; enabled: boolean; version?: string }) => {
    try {
      const profileRoot = profileDir(profile)
      const r = enabled ? enableModFiles(profileRoot, modName) : disableModFiles(profileRoot, modName, version)
      return { success: true, ...r }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('game:launch', async (_e, { valheimPath, mode, profile }) => {
    try {
      const isLinux = process.platform === 'linux'
      const game = findGameExecutable(valheimPath)
      if (!game) {
        return {
          success: false,
          error: isLinux
            ? 'Nem valheim.x86_64 nem valheim.exe foram encontrados no caminho configurado.'
            : 'valheim.exe não encontrado no caminho configurado.',
        }
      }
      const exe = game.path

      if (mode === 'vanilla') {
        // Um launch modado anterior deixa o proxy do doorstop na pasta do jogo
        // (winhttp.dll + doorstop_config.ini + doorstop_libs/). Esse proxy é carregado
        // pelo Valheim em QUALQUER inicialização — inclusive rodando valheim.exe direto —
        // e injeta o BepInEx/mods do perfil. Sem removê-lo, o "vanilla" sobe modado.
        // Removemos os artefatos do doorstop antes de lançar (best-effort: ignora se em uso).
        // Só vale para o executável Windows: no build nativo de Linux o doorstop entra por
        // variável de ambiente (LD_PRELOAD), então não sobra nada na pasta do jogo.
        if (game.kind === 'windows') {
          const doorstopArtifacts = [
            path.join(valheimPath, 'winhttp.dll'),
            path.join(valheimPath, 'doorstop_config.ini'),
          ]
          for (const p of doorstopArtifacts) {
            try { if (fs.existsSync(p)) fs.rmSync(p, { force: true }) } catch { /* em uso? ignora */ }
          }
          try {
            const libs = path.join(valheimPath, 'doorstop_libs')
            if (fs.existsSync(libs)) fs.rmSync(libs, { recursive: true, force: true })
          } catch { /* em uso? ignora */ }
        }

        if (isLinux) {
          // Vanilla não precisa de variável nenhuma, então dá para lançar pela Steam
          // (mantém overlay e contagem de horas). Sem a Steam localizada, roda direto.
          const steam = findSteamLauncherLinux()
          if (steam) {
            console.log('[launch] vanilla via Steam:', steam.cmd, '-applaunch', VALHEIM_APPID)
            spawn(steam.cmd, [...steam.args, '-applaunch', VALHEIM_APPID], {
              detached: true,
              stdio: 'ignore',
            }).unref()
          } else {
            ensureExecutable(exe)
            console.log('[launch] vanilla direto:', exe)
            spawn(exe, [], {
              detached: true,
              stdio: 'ignore',
              cwd: valheimPath,
              env: { ...process.env, SteamAppId: VALHEIM_APPID, SteamGameId: VALHEIM_APPID },
            }).unref()
          }
        } else {
          spawn(exe, [], { detached: true, stdio: 'ignore', cwd: valheimPath }).unref()
        }
      } else {
        const profileRoot = profileDir(profile)

        // Corrige config/ aninhado em plugins/ neste perfil.
        migrateNestedBepInExFolders(profileRoot)

        // ── Modelo r2modman ─────────────────────────────────────────────────────────────
        // NÃO copiamos o BepInEx para a pasta do jogo. Deixamos só o proxy do doorstop
        // (winhttp.dll) na pasta do Steam e apontamos o target para o BepInEx.Preloader.dll
        // DENTRO do perfil. O BepInEx deriva plugins/config/patchers do local do Preloader
        // (confirmado no Entrypoint.cs do BepInEx: BepInExRootPath = 2 níveis acima do
        // Preloader), então tudo carrega direto do perfil — sem cópia pesada a cada launch e
        // sem lixo/configs duplicadas acumulando na pasta do jogo.
        const coreDir = path.join(profileRoot, 'BepInEx', 'core')
        const preloaderSrc = findPreloaderDll(coreDir)
        if (!preloaderSrc) {
          return { success: false, error: `BepInEx.Preloader.dll não encontrado em ${coreDir} — Certifique-se de que o BepInExPack está no modpack e reinstale os mods.` }
        }

        // ── Linux nativo (valheim.x86_64) ────────────────────────────────────────────────
        // Aqui o doorstop não é o winhttp.dll: é o libdoorstop_x64.so injetado por LD_PRELOAD,
        // e toda a configuração vai por variável de ambiente (contrato do doorstop v4, o mesmo
        // que o start_game_bepinex.sh do BepInExPack usa). Nada é copiado para a pasta do jogo.
        //
        // Por isso NÃO lançamos com `steam -applaunch` no modo modado: o -applaunch só manda um
        // pedido para o cliente da Steam já rodando, e o jogo nasce como filho DELE — herdando o
        // ambiente do cliente, não o nosso. As variáveis do doorstop nunca chegariam e o jogo
        // subiria vanilla. Então executamos o binário direto, com o ambiente montado aqui.
        if (isLinux && game.kind === 'native') {
          const doorstopLib = findDoorstopLibLinux(profileRoot)
          if (!doorstopLib) {
            return {
              success: false,
              error: 'libdoorstop_x64.so não encontrado no perfil. Certifique-se de que o BepInExPack está no modpack e reinstale os mods.',
            }
          }
          // O Valheim autentica pelo Steamworks; rodando o binário direto, o cliente da Steam
          // precisa já estar aberto para o SteamAPI conectar nele.
          if (!isSteamRunningLinux()) {
            return {
              success: false,
              error: 'Abra a Steam antes de iniciar no modo modado. O launcher executa o Valheim direto (é o único jeito de os mods carregarem no Linux) e o jogo precisa do cliente da Steam aberto para autenticar.',
            }
          }

          const libDir = path.dirname(doorstopLib)
          const env: Record<string, string> = {
            ...(process.env as Record<string, string>),
            DOORSTOP_ENABLED: '1',
            DOORSTOP_TARGET_ASSEMBLY: preloaderSrc,
            DOORSTOP_IGNORE_DISABLED_ENV: '0',
            DOORSTOP_BOOT_CONFIG_OVERRIDE: '',
            DOORSTOP_MONO_DLL_SEARCH_PATH_OVERRIDE: '',
            DOORSTOP_MONO_DEBUG_ENABLED: '0',
            DOORSTOP_MONO_DEBUG_ADDRESS: '127.0.0.1:10000',
            DOORSTOP_MONO_DEBUG_SUSPEND: '0',
            // Grava o output_log.txt do Unity na pasta do jogo (o mods:openLog já procura lá).
            // É o equivalente ao redirect_output_log do .ini no caminho Windows.
            DOORSTOP_REDIRECT_OUTPUT_LOG: '1',
            // LD_PRELOAD leva só o NOME da lib; quem resolve o caminho é o LD_LIBRARY_PATH.
            LD_LIBRARY_PATH: [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
            LD_PRELOAD: [path.basename(doorstopLib), process.env.LD_PRELOAD].filter(Boolean).join(':'),
            // Sem SteamAppId o Valheim chama RestartAppIfNecessary e se relança PELA Steam —
            // e a instância relançada perde o LD_PRELOAD, ou seja, abre vanilla.
            SteamAppId: VALHEIM_APPID,
            SteamGameId: VALHEIM_APPID,
          }

          ensureExecutable(exe)
          console.log('[launch] linux nativo:', exe)
          console.log('[launch] doorstop lib:', doorstopLib)
          console.log('[launch] preloader (perfil):', preloaderSrc)
          spawn(exe, [], { detached: true, stdio: 'ignore', cwd: valheimPath, env }).unref()
          win.minimize()
          return { success: true }
        }

        function tryCopy(src: string, dest: string) {
          if (!fs.existsSync(src)) return
          try { fs.copyFileSync(src, dest) } catch (e: any) {
            if (e.code !== 'EBUSY') throw e
          }
        }

        // Proxy do doorstop na pasta do jogo (leve: só winhttp.dll + doorstop_libs).
        // Prefere doorstop_libs/x64/winhttp.dll (proxy 64-bit garantido para o Valheim).
        const winhttpX64 = path.join(profileRoot, 'doorstop_libs', 'x64', 'winhttp.dll')
        const winhttpRoot = path.join(profileRoot, 'winhttp.dll')
        const winhttpSrc = fs.existsSync(winhttpX64) ? winhttpX64 : winhttpRoot
        tryCopy(winhttpSrc, path.join(valheimPath, 'winhttp.dll'))
        try { syncDir(path.join(profileRoot, 'doorstop_libs'), path.join(valheimPath, 'doorstop_libs'), false) }
        catch (e: any) { if (e.code !== 'EBUSY') throw e }

        if (!fs.existsSync(path.join(valheimPath, 'winhttp.dll'))) {
          return { success: false, error: 'winhttp.dll não encontrado. Certifique-se de que o BepInExPack está no modpack e reinstale os mods.' }
        }

        // Limpeza única: versões antigas COPIAVAM o BepInEx para a pasta do jogo. Agora ele
        // carrega do perfil, então esse BepInEx na pasta do Steam é lixo ignorado — e era a
        // fonte das configs duplicadas (traduções em dois caminhos). Remove uma vez; best-effort
        // (ignora se o jogo estiver aberto/arquivo em uso).
        const gameBepinex = path.join(valheimPath, 'BepInEx')
        if (fs.existsSync(gameBepinex)) {
          try { fs.rmSync(gameBepinex, { recursive: true, force: true }) } catch { /* em uso? ignora */ }
        }

        // Caminho do Preloader como o doorstop que vai rodar entende: no Linux quem carrega o
        // winhttp.dll é o Wine/Proton, e ele precisa de caminho estilo Windows (Z:\...).
        const doorstopTarget = isLinux ? toWinePath(preloaderSrc) : preloaderSrc

        // doorstop_config.ini apontando para o Preloader do PERFIL (caminho absoluto),
        // compatível com doorstop v3 e v4. redirect_output_log grava output_log.txt na pasta do
        // jogo (captura crashes antes do logger do BepInEx subir).
        const iniPath = path.join(valheimPath, 'doorstop_config.ini')
        if (fs.existsSync(iniPath)) fs.unlinkSync(iniPath)
        const doorstopIni = [
          '[General]',
          'enabled = true',
          `target_assembly = ${doorstopTarget}`,
          'redirect_output_log = true',
          'boot_config_override =',
          'ignore_disable_switch = false',
          '',
          '[UnityDoorstop]',
          'enabled=true',
          `targetAssembly=${doorstopTarget}`,
          'redirect_output_log=true',
          'ignore_disable_switch=false',
          '',
        ].join('\r\n')
        fs.writeFileSync(iniPath, doorstopIni, { encoding: 'utf8' })

        console.log('[launch] winhttp.dll size:', fs.statSync(path.join(valheimPath, 'winhttp.dll')).size, 'bytes')
        console.log('[launch] preloader (perfil):', preloaderSrc)
        console.log('[launch] ini written:', doorstopIni.replace(/\r\n/g, '↵'))

        // ── Launch estilo r2modman ───────────────────────────────────────────────────────
        // Lançamos PELA STEAM passando o caminho do Preloader como argumento do doorstop, em
        // vez de rodar valheim.exe direto. Motivo: rodar o exe direto faz o Valheim se relançar
        // pela Steam em algumas máquinas, e a instância relançada sobe SEM o doorstop (abre
        // vanilla, sem terminal). Lançar pela Steam evita o relançamento e o argumento trafega
        // em UTF-16 (Unicode-safe), sem depender do doorstop_config.ini (que fica de fallback).
        // O proxy winhttp.dll continua obrigatório na pasta do jogo (copiado acima).
        // doorstop v4 usa doorstop_libs/ + flag --doorstop-enabled; v3 usa --doorstop-enable.
        const hasDoorstopLibs = fs.existsSync(path.join(profileRoot, 'doorstop_libs'))
        const doorstopArgs = hasDoorstopLibs
          ? ['--doorstop-enabled', 'true', '--doorstop-target-assembly', doorstopTarget]
          : ['--doorstop-enable', 'true', '--doorstop-target-assembly', doorstopTarget, '--doorstop-target', doorstopTarget]

        // ── Linux com o depot Windows (Proton) ───────────────────────────────────────────
        // O doorstop aqui é o winhttp.dll rodando dentro do Wine, e o Wine só carrega a nossa
        // dll no lugar da builtin dele se o jogo subir com WINEDLLOVERRIDES. Isso mora nas
        // opções de inicialização da Steam (config por jogo, do usuário) — o launcher não tem
        // como injetar, então lançamos e avisamos o que falta configurar uma vez.
        if (isLinux) {
          const steam = findSteamLauncherLinux()
          if (!steam) {
            return { success: false, error: 'Steam não encontrada. Instale/abra a Steam para iniciar o Valheim no modo modado.' }
          }
          console.log('[launch] proton via Steam:', steam.cmd, '-applaunch', VALHEIM_APPID, doorstopArgs.join(' '))
          spawn(steam.cmd, [...steam.args, '-applaunch', VALHEIM_APPID, ...doorstopArgs], {
            detached: true,
            stdio: 'ignore',
          }).unref()
          win.minimize()
          return {
            success: true,
            warning:
              'Seu Valheim está instalado na versão Windows (roda por Proton). Para os mods carregarem, ' +
              'abra as Propriedades do Valheim na Steam e cole isto em OPÇÕES DE INICIALIZAÇÃO:\n\n' +
              'WINEDLLOVERRIDES="winhttp=n,b" %command%\n\n' +
              'É uma vez só. Alternativa: nas Propriedades → Compatibilidade, desmarque a camada de ' +
              'compatibilidade para a Steam baixar a versão nativa de Linux — aí o launcher cuida de tudo sozinho.',
          }
        }

        const steamExe = findSteamExe(valheimPath)
        if (steamExe) {
          console.log('[launch] via Steam:', steamExe, '-applaunch', VALHEIM_APPID, doorstopArgs.join(' '))
          spawn(steamExe, ['-applaunch', VALHEIM_APPID, ...doorstopArgs], {
            detached: true,
            stdio: 'ignore',
            cwd: valheimPath,
          }).unref()
        } else {
          // Fallback 1: protocolo steam://run (resolvido pelo Windows, sem precisar do Steam.exe).
          // Fallback 2: se nem o protocolo abrir, cai no launch direto do exe (comportamento antigo).
          const argStr = doorstopArgs.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')
          const steamUrl = `steam://run/${VALHEIM_APPID}//${encodeURIComponent(argStr)}`
          console.log('[launch] via steam:// protocolo:', steamUrl)
          shell.openExternal(steamUrl).catch(() => {
            const batPath = path.join(valheimPath, 'Hofheim_launch.bat')
            fs.writeFileSync(batPath, ['@echo off', `cd /d "${valheimPath}"`, `start "" "${exe}"`, ''].join('\r\n'))
            shell.openPath(batPath)
          })
        }
      }
      win.minimize()
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.on('shell:openExternal', (_e, url: string) => {
    // Só http/https. Bloqueia file://, protocolos perigosos do Windows etc. — o url pode vir de
    // dados remotos (links de notícias/modpack), então um esquema malicioso viraria execução.
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url)
  })

  // ── Local filesystem helpers (config editor) ──────────────────────────────
  ipcMain.handle('fs:pickDir', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Selecionar pasta BepInEx/config',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    // A pasta escolhida no diálogo passa a ser uma raiz liberada para fs:read/write/listDir
    // nesta sessão. Só caminhos dentro de raízes escolhidas explicitamente pelo usuário (ou da
    // raiz de perfis) podem ser lidos/gravados — o renderer não consegue mais tocar arquivos arbitrários.
    allowedFsRoots.add(path.resolve(result.filePaths[0]))
    return result.filePaths[0]
  })

  ipcMain.handle('fs:openInExplorer', async (_e, { dirPath }: { dirPath: string }) => {
    try {
      if (!dirPath) return { success: false, error: 'Caminho não definido' }
      // Confina a raízes liberadas (perfis + pastas escolhidas em diálogo). Sem isso, o renderer
      // poderia criar/abrir pastas arbitrárias no disco via este handler.
      if (!isPathAllowed(dirPath)) return { success: false, error: 'Acesso negado a esta pasta' }
      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true })
      const err = await shell.openPath(dirPath)
      if (err) return { success: false, error: err }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  /**
   * Libera uma pasta ARRASTADA para dentro da janela como raiz de leitura desta sessão —
   * o equivalente do fs:pickDir para quem prefere arrastar a pasta `config` em vez de
   * navegar no diálogo.
   *
   * Diferença de confiança em relação ao diálogo: lá o gesto acontece numa janela do SO, que
   * o renderer não consegue fabricar; aqui o gesto acontece no renderer, então o main não tem
   * como comprová-lo. Por isso o que pode ser liberado é ESTREITO: precisa existir, ser pasta,
   * e chamar-se `config` (é sempre `BepInEx/config`). Isso impede que uma chamada indevida
   * libere `C:\` ou a pasta do usuário, e de bônus barra o erro comum de arrastar a pasta
   * `BepInEx` (que faria todo config virar `BepInEx/config/config/...`). Para qualquer outro
   * nome de pasta, o diálogo continua sendo o caminho.
   */
  ipcMain.handle('fs:allowDroppedConfigDir', async (_e, { dirPath }: { dirPath: string }) => {
    try {
      if (typeof dirPath !== 'string' || !dirPath.trim()) {
        return { success: false, error: 'Caminho inválido' }
      }
      const resolved = path.resolve(dirPath)
      let stat: fs.Stats
      try { stat = fs.statSync(resolved) } catch { return { success: false, error: 'Pasta não encontrada' } }
      if (!stat.isDirectory()) {
        return { success: false, error: 'Arraste a PASTA config, não um arquivo.' }
      }
      if (path.basename(resolved).toLowerCase() !== 'config') {
        return {
          success: false,
          error: `Arraste a pasta chamada "config" (a que fica dentro de BepInEx) — você arrastou "${path.basename(resolved)}". ` +
            'Para outra pasta, use o botão Buscar.',
        }
      }
      allowedFsRoots.add(resolved)
      return { success: true, dirPath: resolved }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('fs:listDir', async (_e, { dir }: { dir: string }) => {
    try {
      if (!isPathAllowed(dir)) return { success: false, error: 'Acesso negado a esta pasta' }
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return { success: false, error: 'Pasta não encontrada' }
      }
      // Percorre subpastas: vários mods guardam configs em pastas próprias dentro de
      // BepInEx/config/ (ex.: config/DistantOrigins/Translations/Mod.yml). Sem recursão esses
      // arquivos nunca apareciam no editor. Retornamos caminhos RELATIVOS em estilo posix (/),
      // que o frontend concatena com o dir (readFile/writeFile) e usa como installPath.
      // Texto (editável inline) + binários que alguns mods guardam em config/ (ex.:
      // spritesheet .png de emoji, músicas .ogg/.mp3, gifs, fontes). Os binários
      // aparecem na lista para o admin enviá-los ao R2; o frontend detecta pelo
      // installPath (isBinaryConfigPath). A parte binária espelha BINARY_CONFIG_EXT_RE
      // em src/utils/modManager.ts — manter em sincronia.
      const CONFIG_RE =
        /\.(cfg|json|yaml|yml|ini|toml|txt|png|jpe?g|gif|webp|bmp|ico|tga|dds|mp3|ogg|wav|flac|aac|m4a|mp4|webm|mov|mkv|ttf|otf|woff2?|zip|dll|bin|dat|pdf|unity3d|assetbundle|bundle)$/i
      const files: string[] = []
      // Arquivos que existem na pasta mas cuja extensão não é reconhecida como config.
      // Vão separados (não somem em silêncio): o espelhamento precisa saber que eles EXISTEM
      // no disco pra não remover a entrada correspondente do modpack, e o admin precisa ver
      // que ficaram de fora.
      const unknown: string[] = []
      const walk = (current: string, rel: string) => {
        for (const name of fs.readdirSync(current)) {
          const abs = path.join(current, name)
          const relPath = rel ? `${rel}/${name}` : name
          let stat: fs.Stats
          try { stat = fs.statSync(abs) } catch { continue }
          if (stat.isDirectory()) walk(abs, relPath)
          else if (CONFIG_RE.test(name)) files.push(relPath)
          else unknown.push(relPath)
        }
      }
      walk(dir, '')
      files.sort()
      unknown.sort()
      return { success: true, files, unknown }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('fs:readFile', async (_e, { filePath }: { filePath: string }) => {
    try {
      if (!isPathAllowed(filePath)) return { success: false, error: 'Acesso negado a este arquivo' }
      const content = fs.readFileSync(filePath, 'utf-8')
      return { success: true, content }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('fs:readFileBase64', async (_e, { filePath }: { filePath: string }) => {
    // Lê um arquivo como base64 (bytes crus), sem decodificar como UTF-8. Usado para
    // configs binários (ex.: .png de emoji) que serão enviados ao R2 — ler como texto
    // corromperia os bytes. Mesmo confinamento de caminho do fs:readFile.
    try {
      if (!isPathAllowed(filePath)) return { success: false, error: 'Acesso negado a este arquivo' }
      const content = fs.readFileSync(filePath).toString('base64')
      return { success: true, content }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  /**
   * sha256 + tamanho de um arquivo do disco, em streaming (não carrega os bytes na memória
   * nem os manda pro renderer). Serve para o espelhamento de pasta decidir se um config
   * BINÁRIO mudou: a key do R2 é content-addressed (`{sha8}-{nome}`), então basta comparar
   * o hash local com o que já está na URL do modpack — sem isso, espelhar reenviaria
   * centenas de imagens/músicas ao R2 a cada vez.
   */
  ipcMain.handle('fs:hashFile', async (_e, { filePath }: { filePath: string }) => {
    try {
      if (!isPathAllowed(filePath)) return { success: false, error: 'Acesso negado a este arquivo' }
      const size = fs.statSync(filePath).size
      const sha256 = await new Promise<string>((resolve, reject) => {
        const h = crypto.createHash('sha256')
        const rs = fs.createReadStream(filePath)
        rs.on('data', chunk => h.update(chunk))
        rs.on('error', reject)
        rs.on('end', () => resolve(h.digest('hex')))
      })
      return { success: true, sha256, size }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('fs:writeFile', async (_e, { filePath, content }: { filePath: string; content: string }) => {
    try {
      if (!isPathAllowed(filePath)) return { success: false, error: 'Acesso negado a este arquivo' }
      fs.writeFileSync(filePath, content, 'utf-8')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('mods:importR2Code', async (_e, { code }: { code: string }) => {
    // A "código R2ModManager" pasted by the user is NOT the profile data itself — it's a
    // short lookup key. r2modman uploads the exported profile to Thunderstore and the code
    // just references it; the actual data has to be fetched from Thunderstore's API.
    // Response body is plain text: "#r2modman" + base64(r2z zip bytes).
    // Source: https://github.com/ebkr/r2modmanPlus (src/r2mm/mods/ProfileImportExport.ts,
    // src/r2mm/profiles/ProfilesClient.ts, src/utils/ProfileUtils.ts)
    try {
      const axios = require('axios')
      const trimmedCode = code.trim()
      let profileData: string
      try {
        const response = await axios.get(
          `https://thunderstore.io/api/experimental/legacyprofile/get/${encodeURIComponent(trimmedCode)}/`,
          { timeout: 15000, responseType: 'text', transformResponse: (data: any) => data },
        )
        profileData = response.data
      } catch (err: any) {
        if (err.response?.status === 404) {
          return { success: false, error: 'Código não encontrado ou expirado. Códigos do R2ModManager valem só algumas horas — peça um novo.' }
        }
        return { success: false, error: `Falha ao buscar o código no Thunderstore: ${err.message}` }
      }

      const PREFIX = '#r2modman'
      if (typeof profileData !== 'string' || !profileData.startsWith(PREFIX)) {
        return { success: false, error: 'Código inválido — a resposta do Thunderstore não tem o formato esperado.' }
      }
      const zipBuffer = Buffer.from(profileData.slice(PREFIX.length).trim(), 'base64')

      return parseR2ProfileZip(zipBuffer)
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('mods:pickAndImportR2File', async () => {
    // Importa um perfil exportado do R2ModManager como ARQUIVO (.r2z). O r2z é um ZIP
    // binário (export.r2x + config/), diferente do .Hofheim que é JSON texto — por isso
    // tem seu próprio picker e lê os bytes crus, sem passar por JSON.parse.
    try {
      const result = await dialog.showOpenDialog(win, {
        title: 'Importar perfil do R2ModManager (.r2z)',
        filters: [
          { name: 'Perfil R2ModManager', extensions: ['r2z', 'zip'] },
          { name: 'Todos os arquivos', extensions: ['*'] },
        ],
        properties: ['openFile'],
      })
      if (result.canceled || !result.filePaths[0]) return null
      const zipBuffer = fs.readFileSync(result.filePaths[0])
      return parseR2ProfileZip(zipBuffer)
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('fs:pickJsonFile', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Importar modpack',
      filters: [{ name: 'Hofheim Modpack', extensions: ['Hofheim', 'json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return fs.readFileSync(result.filePaths[0], 'utf-8')
  })

  ipcMain.handle('fs:saveFileDialog', async (_e, { filename, content }: { filename: string; content: string }) => {
    const result = await dialog.showSaveDialog(win, {
      title: 'Exportar modpack',
      defaultPath: filename,
      filters: [
        { name: 'Hofheim Modpack', extensions: ['Hofheim'] },
        { name: 'JSON', extensions: ['json'] },
      ],
    })
    if (result.canceled || !result.filePath) return { success: false }
    fs.writeFileSync(result.filePath, content, 'utf-8')
    return { success: true }
  })

  // Status do servidor consultado direto no IP (Steam A2S/UDP). Fica no main porque o
  // renderer não faz UDP; consultas para o mesmo endereço são compartilhadas para não
  // disparar vários pacotes quando sidebar e home pedem ao mesmo tempo.
  const serverStatusInFlight = new Map<string, Promise<any>>()

  ipcMain.handle('server:status', async (_e, { address, timeoutMs }: { address: string; timeoutMs?: number }) => {
    const parsed = parseServerAddress(address)
    if (!parsed) {
      return { online: false, players: 0, maxPlayers: 0, error: 'endereço do servidor inválido' }
    }
    const timeout = Math.min(Math.max(timeoutMs ?? 4000, 500), 10_000)
    const key = `${parsed.host}:${parsed.port}:${timeout}`
    const pending = serverStatusInFlight.get(key)
    if (pending) return pending

    const promise = queryServerStatus(parsed.host, parsed.port, timeout)
      .catch(err => ({
        online: false,
        players: 0,
        maxPlayers: 0,
        error: err?.message || 'falha ao consultar o servidor',
      }))
      .finally(() => { serverStatusInFlight.delete(key) })

    serverStatusInFlight.set(key, promise)
    return promise
  })

  ipcMain.handle('thunderstore:fetchAll', async () => {
    const axios = require('axios')
    const response = await axios.get('https://thunderstore.io/c/valheim/api/v1/package/', {
      timeout: 60000,
      headers: { 'Accept-Encoding': 'gzip, deflate' },
    })
    const raw: any[] = response.data
    if (!Array.isArray(raw)) {
      throw new Error('Resposta inesperada do Thunderstore')
    }
    // Normalize in the main process before IPC transfer:
    // raw response is ~156MB uncompressed; trimming to essential fields reduces it to ~5MB
    // Note: Thunderstore API no longer includes total_downloads at package level — sum from versions
    return raw
      .filter((pkg: any) => Array.isArray(pkg.versions) && pkg.versions.length > 0)
      .map((pkg: any) => {
        const v = pkg.versions[0]
        const total_downloads = pkg.versions.reduce((sum: number, ver: any) => sum + (ver.downloads || 0), 0)
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
          // Only version_number per version (~8 bytes each) — URL reconstructed via getDownloadUrl
          versions: (pkg.versions as any[]).map((ver: any) => ({ version_number: ver.version_number })),
        }
      })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})