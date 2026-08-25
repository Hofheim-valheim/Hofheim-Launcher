import { useState, useEffect } from 'react'
import './UpdateNotification.css'

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function UpdateNotification() {
  const [status, setStatus] = useState<'available' | 'downloaded' | 'error' | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [newVersion, setNewVersion] = useState('')
  const [progress, setProgress] = useState<{ percent: number; transferred: number; total: number } | null>(null)
  const [slowTimeout, setSlowTimeout] = useState(false)

  useEffect(() => {
    let slowTimer: ReturnType<typeof setTimeout> | null = null

    function handleStatus(data: { status: string; message?: string; version?: string }) {
      if (data.version) setNewVersion(data.version)
      if (data.status === 'available') {
        setStatus('available')
        slowTimer = setTimeout(() => setSlowTimeout(true), 10000)
      } else if (data.status === 'downloaded') {
        setStatus('downloaded')
        if (slowTimer) clearTimeout(slowTimer)
      } else if (data.status === 'error') {
        setStatus('error')
        setErrorMsg(data.message || 'Erro desconhecido')
        if (slowTimer) clearTimeout(slowTimer)
      }
      // `not-available` não vira barra: aparecer "você está atualizado" em toda abertura seria
      // ruído. Quem mostra esse caso é a checagem manual, na tela Sobre.
    }

    function handleProgress(data: { percent: number; transferred: number; total: number }) {
      setSlowTimeout(false)
      setProgress(data)
    }

    window.Hofheim.updater.onStatus(handleStatus)
    window.Hofheim.updater.onProgress(handleProgress)

    // A checagem automática começa 3s após o app abrir e pode terminar ANTES deste componente
    // montar; o send do main não enfileira, então sem isto a barra simplesmente nunca aparecia.
    window.Hofheim.updater.getStatus().then(last => { if (last) handleStatus(last) }).catch(() => {})

    return () => {
      if (slowTimer) clearTimeout(slowTimer)
    }
  }, [])

  if (!status) return null

  return (
    <div className="update-bar">
      <div className={`update-bar-icon ${status === 'error' ? 'error' : ''}`}>
        {status === 'error' ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7,10 12,15 17,10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        )}
      </div>

      <div className="update-bar-info">
        {status === 'available' && (
          <>
            <span className="update-bar-label">Baixando atualização...</span>
            {progress ? (
              <div className="update-bar-progress">
                <div className="update-bar-track">
                  <div className="update-bar-fill" style={{ width: `${progress.percent}%` }} />
                </div>
                <span className="update-bar-stats">
                  {formatBytes(progress.transferred)} / {formatBytes(progress.total)}
                </span>
              </div>
            ) : (
              <span className="update-bar-desc">
                {slowTimeout ? 'Download lento, aguarde...' : 'Preparando...'}
              </span>
            )}
          </>
        )}

        {status === 'downloaded' && (
          <>
            <span className="update-bar-label">
              {newVersion ? `Atualização ${newVersion} pronta!` : 'Atualização pronta!'}
            </span>
            <span className="update-bar-desc">Reinicie para aplicar.</span>
          </>
        )}

        {status === 'error' && (
          <>
            <span className="update-bar-label error">Falha na atualização</span>
            <span className="update-bar-desc" title={errorMsg}>
              {errorMsg.length > 80 ? errorMsg.slice(0, 80) + '…' : errorMsg}
            </span>
          </>
        )}
      </div>

      <div className="update-bar-actions">
        {status === 'downloaded' && (
          <button className="update-bar-btn" onClick={() => window.Hofheim.updater.install()}>
            Reiniciar
          </button>
        )}
        {(status === 'downloaded' || status === 'error') && (
          <button className="update-bar-close" onClick={() => setStatus(null)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
