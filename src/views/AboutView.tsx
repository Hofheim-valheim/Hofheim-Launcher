import { useEffect, useState } from 'react'
import { Modpack } from '../types'
import { DISCORD_URL, WEBSITE_URL } from '../constants/links'
import './AboutView.css'

interface Props {
  modpack: Modpack | null
}

const RULES = [
  'Respeite os outros jogadores — sem assédio, discurso de ódio ou toxicidade.',
  'Proibido griefing, roubo ou destruição de construções de outros jogadores sem consentimento.',
  'Proibido uso de cheats, exploits ou qualquer vantagem indevida.',
  'Divulgação de servidores concorrentes não é permitida no Discord.',
]

export default function AboutView({ modpack }: Props) {
  /**
   * Versão INSTALADA do launcher + checagem manual de atualização. Antes não havia nada disso na
   * interface: a única "Versão" visível era a do modpack, então não dava para saber em que versão
   * o launcher estava, nem distinguir "já estou atualizado" de "a checagem falhou em silêncio".
   */
  const [appInfo, setAppInfo] = useState<{ version: string; packaged: boolean; updaterSupported: boolean } | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState('')

  useEffect(() => {
    window.Hofheim.app.info().then(setAppInfo).catch(() => {})
  }, [])

  async function handleCheckUpdate() {
    setChecking(true)
    setCheckResult('')
    try {
      const r = await window.Hofheim.updater.check()
      if (r.success) {
        // `latestVersion` é a versão publicada; se for igual à instalada, está em dia. Quando há
        // atualização, o download já começou e a barra de atualização assume daqui.
        setCheckResult(
          r.latestVersion && r.latestVersion !== r.version
            ? `Atualização ${r.latestVersion} encontrada — o download começou.`
            : `Você já está na versão mais recente (${r.version}).`,
        )
      } else if (r.reason === 'dev') {
        setCheckResult('Atualização automática só funciona na versão instalada (build empacotado).')
      } else if (r.reason === 'unsupported') {
        setCheckResult('Esta instalação não recebe atualização automática (no Linux, apenas o AppImage). Baixe a versão nova manualmente.')
      } else {
        setCheckResult(r.error || 'Não foi possível verificar atualizações.')
      }
    } catch (err: any) {
      setCheckResult(err?.message || 'Não foi possível verificar atualizações.')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="about-view">
      <div className="about-header">
        <h1>Sobre o servidor</h1>
        <p className="text-secondary">Tudo o que você precisa saber sobre o Hofheim.</p>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Descrição</h3>
        </div>
        <div className="card-body">
          <p className="text-secondary">
            {modpack?.description || 'Servidor de Valheim com raças, classes e aventuras épicas. Junte-se a nós!'}
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Regras</h3>
        </div>
        <div className="card-body">
          <ul className="about-rules">
            {RULES.map((rule, i) => (
              <li key={i}>{rule}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Informações</h3>
        </div>
        <div className="card-body">
          <div className="about-info-row">
            <span className="about-info-label">Modpack</span>
            <span className="about-info-value">{modpack?.name || 'Vanilla'}</span>
          </div>
          {modpack?.version && (
            <div className="about-info-row">
              <span className="about-info-label">Versão do modpack</span>
              <span className="about-info-value">{modpack.version}</span>
            </div>
          )}
          <div className="about-info-row">
            <span className="about-info-label">Versão do launcher</span>
            <span className="about-info-value">
              {appInfo ? appInfo.version : '...'}
              {appInfo && !appInfo.packaged && ' (dev)'}
            </span>
          </div>
          <div style={{ marginTop: 12 }}>
            <button className="btn-secondary" onClick={handleCheckUpdate} disabled={checking}>
              {checking ? 'Verificando...' : 'Verificar atualizações'}
            </button>
            {checkResult && (
              <p className="text-secondary" style={{ fontSize: 13, marginTop: 8, marginBottom: 0 }}>{checkResult}</p>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Links úteis</h3>
        </div>
        <div className="card-body about-links">
          <button className="btn-secondary" onClick={() => window.Hofheim.shell.openExternal(DISCORD_URL)}>
            Discord
          </button>
          <button className="btn-secondary" onClick={() => window.Hofheim.shell.openExternal(WEBSITE_URL)}>
            Instagram
          </button>
        </div>
      </div>
    </div>
  )
}
