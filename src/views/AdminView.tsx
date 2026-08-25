import { useState } from 'react'
import { Config, NewsData } from '../types'
import './AdminView.css'

interface Props {
  config: Config
  adminToken: string | null
  onSave: (updates: Partial<Config>) => Promise<void>
  serverInfo?: { ip?: string; uptime?: string; version?: string }
  /** Status vindo da consulta direta ao IP (não é editável — é o servidor de verdade). */
  serverOnline?: boolean
  serverPlayers?: number
  serverMaxPlayers?: number
  serverChecking?: boolean
  serverVersion?: string
  onPublishNews?: (updates: Partial<NewsData>) => Promise<void>
}

export default function AdminView({
  config,
  onSave,
  serverInfo,
  serverOnline = false,
  serverPlayers = 0,
  serverMaxPlayers = 0,
  serverChecking = false,
  serverVersion = '',
  onPublishNews,
}: Props) {
  const [backendUrl, setBackendUrl] = useState(config.backendUrl || '')
  const [modpackRepo, setModpackRepo] = useState(config.modpackRepo || '')
  const [modpackBranch, setModpackBranch] = useState(config.modpackBranch || 'main')
  const [newsUrl, setNewsUrl] = useState(config.newsUrl || '')

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const [serverIp, setServerIp] = useState(serverInfo?.ip || '')
  const [serverUptime, setServerUptime] = useState(serverInfo?.uptime || '')
  const [savingInfo, setSavingInfo] = useState(false)
  const [savedInfo, setSavedInfo] = useState(false)
  const [infoError, setInfoError] = useState('')

  const hasChanges =
    backendUrl !== (config.backendUrl || '') ||
    modpackRepo !== (config.modpackRepo || '') ||
    modpackBranch !== (config.modpackBranch || 'main') ||
    newsUrl !== (config.newsUrl || '')

  const hasInfoChanges =
    serverIp !== (serverInfo?.ip || '') ||
    serverUptime !== (serverInfo?.uptime || '')

  async function handleSaveServerInfo() {
    if (!onPublishNews) return
    setSavingInfo(true)
    setSavedInfo(false)
    setInfoError('')
    try {
      await onPublishNews({
        serverInfo: {
          ip: serverIp || undefined,
          uptime: serverUptime || undefined,
        },
      })
      setSavedInfo(true)
      setTimeout(() => setSavedInfo(false), 2000)
    } catch (err: any) {
      setInfoError(err.message || 'Falha ao salvar')
    } finally {
      setSavingInfo(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      await onSave({ backendUrl, modpackRepo, modpackBranch, newsUrl })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="admin-view">
      <div className="admin-header">
        <h1>Painel Admin</h1>
        <p className="text-secondary">Status do servidor, backend e repositório do modpack.</p>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="admin-section card">
        <div className="card-header"><h3>Status do Servidor</h3></div>
        <div className="card-body">
          {/* Leitura da consulta direta ao IP abaixo — não existe mais chave manual de
              online/offline: o que aparece aqui é o que os jogadores veem na home. */}
          <div className="server-status-info">
            <span className={`status-dot-admin ${serverChecking ? 'checking' : serverOnline ? 'online' : 'offline'}`} />
            <span className="server-status-label">
              {serverChecking ? (
                <>Consultando o servidor...</>
              ) : serverOnline ? (
                <>Servidor está <strong>Online</strong> — {serverPlayers}/{serverMaxPlayers} jogadores{serverVersion ? ` — v${serverVersion}` : ''}</>
              ) : serverInfo?.ip ? (
                <>Servidor está <strong>Offline</strong> (não respondeu à consulta)</>
              ) : (
                <>Sem IP configurado — preencha abaixo para o launcher consultar o servidor</>
              )}
            </span>
          </div>

          <div className="form-group" style={{ marginTop: 20 }}>
            <label>IP do servidor</label>
            <input type="text" value={serverIp} onChange={e => setServerIp(e.target.value)}
              placeholder="Hofheim.gg:2456" style={{ fontFamily: 'monospace' }} />
            <span className="form-hint">
              O launcher consulta este endereço direto (Steam A2S) para mostrar online/offline e
              jogadores em tempo real. Use a porta do jogo (2456) — a de consulta (2457) é deduzida.
            </span>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Uptime / Temporada</label>
            <input type="text" value={serverUptime} onChange={e => setServerUptime(e.target.value)}
              placeholder="Season 3 — 42 dias" />
          </div>
          {infoError && <div className="error-banner" style={{ marginTop: 16 }}>{infoError}</div>}
          <div className="admin-actions" style={{ marginTop: 16 }}>
            <button className="btn-secondary" onClick={handleSaveServerInfo} disabled={!hasInfoChanges || savingInfo}>
              {savingInfo ? 'Salvando...' : savedInfo ? 'Salvo!' : 'Salvar informações do servidor'}
            </button>
          </div>
        </div>
      </div>

      <div className="admin-section card">
        <div className="card-header"><h3>Backend e Repositório</h3></div>
        <div className="card-body">
          <div className="form-group">
            <label>URL do Backend (Cloudflare)</label>
            <input type="text" value={backendUrl} onChange={e => setBackendUrl(e.target.value)}
              placeholder="https://Hofheim-launcher-backend.Hofheim-valhala.workers.dev" />
            <span className="form-hint">Usado para login, publicar modpacks e mods privados.</span>
          </div>
          <div className="form-group">
            <label>Repositório do Modpack (owner/repo)</label>
            <input type="text" value={modpackRepo} onChange={e => setModpackRepo(e.target.value)}
              placeholder="HofheimBr/Hofheim-modpack" />
            <span className="form-hint">Onde fica o modpack.json público (lido via raw GitHub).</span>
          </div>
          <div className="form-group">
            <label>Branch</label>
            <input type="text" value={modpackBranch} onChange={e => setModpackBranch(e.target.value)}
              placeholder="main" style={{ width: '150px' }} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>URL das Notícias (opcional)</label>
            <input type="text" value={newsUrl} onChange={e => setNewsUrl(e.target.value)}
              placeholder="https://raw.githubusercontent.com/.../news.json" />
          </div>
        </div>
      </div>

      <div className="admin-actions">
        <button className="btn-play" style={{ width: 'auto', padding: '12px 32px' }}
          onClick={handleSave} disabled={!hasChanges || saving}>
          {saving ? 'Salvando...' : saved ? 'Salvo!' : 'Salvar'}
        </button>
      </div>
    </div>
  )
}
