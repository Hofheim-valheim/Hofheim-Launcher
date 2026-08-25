import { useState, useEffect } from 'react'
import { Config } from '../types'
import './SettingsView.css'

interface Props {
  config: Config
  onSave: (updates: Partial<Config>) => Promise<void>
}

export default function SettingsView({ config, onSave }: Props) {
  const [valheimPath, setValheimPath] = useState(config.valheimPath)
  const [modsPath, setModsPath] = useState(config.modsPath || '')
  const [defaultModsPath, setDefaultModsPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [openError, setOpenError] = useState('')

  useEffect(() => {
    window.Hofheim.mods.defaultPath().then(p => setDefaultModsPath(p))
  }, [])

  async function handleSelectValheimPath() {
    const p = await window.Hofheim.dialog.selectValheimPath()
    if (p) setValheimPath(p)
  }

  async function handleAutoDetect() {
    const p = await window.Hofheim.valheim.autoDetect()
    if (p) setValheimPath(p)
  }

  async function handleSelectModsPath() {
    const p = await window.Hofheim.fs.pickDir()
    if (p) setModsPath(p)
  }

  async function handleOpenFolder(dirPath: string) {
    setOpenError('')
    const res = await window.Hofheim.fs.openInExplorer({ dirPath })
    if (!res.success) setOpenError(res.error || 'Erro ao abrir pasta')
  }

  async function handleOpenLog() {
    setOpenError('')
    const res = await window.Hofheim.mods.openLog({ valheimPath, profile: config.selectedModpack })
    if (!res.success) setOpenError(res.error || 'Erro ao abrir log')
  }

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    try {
      await onSave({ valheimPath, modsPath: modsPath || undefined })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  const hasChanges =
    valheimPath !== config.valheimPath ||
    modsPath !== (config.modsPath || '')

  return (
    <div className="settings-view">
      <div className="settings-header">
        <h1>Configuracoes</h1>
        <p className="text-secondary">Ajuste as opcoes do launcher.</p>
      </div>

      {openError && (
        <div className="error-banner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{openError}</span>
        </div>
      )}

      <div className="settings-section card">
        <div className="card-header">
          <h3>Caminho do Valheim</h3>
        </div>
        <div className="card-body">
          <p className="setting-description">
            Selecione a pasta onde o Valheim esta instalado.
          </p>
          <div className="path-input-group">
            <input
              type="text"
              value={valheimPath}
              onChange={e => setValheimPath(e.target.value)}
              placeholder="C:\Program Files\Steam\steamapps\common\Valheim"
              className="path-input"
            />
            <button className="btn-secondary" onClick={handleSelectValheimPath}>
              Procurar...
            </button>
            <button className="btn-ghost" onClick={handleAutoDetect}>
              Auto-detectar
            </button>
            <button
              className="btn-ghost btn-icon"
              onClick={() => handleOpenFolder(valheimPath)}
              disabled={!valheimPath}
              title="Abrir pasta no gerenciador de arquivos"
            >
              <FolderIcon />
            </button>
          </div>
        </div>
      </div>

      <div className="settings-section card">
        <div className="card-header">
          <h3>Pasta de instalacao de mods</h3>
        </div>
        <div className="card-body">
          <p className="setting-description">
            Pasta onde os perfis e mods serao instalados (ex: <code>F:\Games\Hofheim</code>).
            Ao trocar o caminho, os mods serao reinstalados na nova localizacao.
          </p>
          <div className="path-input-group">
            <input
              type="text"
              value={modsPath}
              onChange={e => setModsPath(e.target.value)}
              placeholder={defaultModsPath || '%APPDATA%\\HofheimLauncher\\profiles'}
              className="path-input"
            />
            <button className="btn-secondary" onClick={handleSelectModsPath}>
              Procurar...
            </button>
            {modsPath && (
              <button className="btn-ghost" onClick={() => setModsPath('')}>
                Usar padrao
              </button>
            )}
            <button
              className="btn-ghost btn-icon"
              onClick={() => handleOpenFolder(modsPath || defaultModsPath)}
              disabled={!modsPath && !defaultModsPath}
              title="Abrir pasta no gerenciador de arquivos"
            >
              <FolderIcon />
            </button>
          </div>
          {defaultModsPath && (
            <p className="setting-hint">
              Padrao: {defaultModsPath}
            </p>
          )}
        </div>
      </div>

      <div className="settings-section card">
        <div className="card-header">
          <h3>Logs</h3>
        </div>
        <div className="card-body">
          <p className="setting-description">
            Se estiver tendo erros com mods, abra o log para ver o que aconteceu — ele
            registra falhas de carregamento e exceções, igual ao log do R2ModManager.
          </p>
          <button className="btn-secondary" onClick={handleOpenLog} disabled={!valheimPath}>
            Abrir log
          </button>
        </div>
      </div>

      <div className="settings-actions">
        <button
          className="btn-play"
          style={{ width: 'auto', padding: '12px 32px' }}
          onClick={handleSave}
          disabled={!hasChanges || saving}
        >
          {saving ? 'Salvando...' : saved ? 'Salvo!' : 'Salvar'}
        </button>
      </div>
    </div>
  )
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}
