import { useState, useRef, useEffect } from 'react'
import logoImg from '../../assets/logo.png'
import { DISCORD_URL, WEBSITE_URL } from '../../constants/links'
import { ModpackEntry } from '../../types'
import './Sidebar.css'

interface Props {
  currentView: string
  onViewChange: (view: string) => void
  selectedModpack: string
  modpacks: ModpackEntry[]
  onModpackChange: (id: string) => void
  onPlay: () => void
  isPlaying: boolean
  modpackVersion?: string
  isAdmin: boolean
  serverOnline?: boolean
  serverPlayers?: number
  serverMaxPlayers?: number
  hasServerStatus?: boolean
  serverChecking?: boolean
}

export default function Sidebar({
  currentView,
  onViewChange,
  selectedModpack,
  modpacks,
  onModpackChange,
  onPlay,
  isPlaying,
  modpackVersion,
  isAdmin,
  serverOnline,
  serverPlayers,
  serverMaxPlayers,
  hasServerStatus,
  serverChecking,
}: Props) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const selectedModpackData = modpacks.find(m => m.id === selectedModpack)

  // Os mundos do Hofheim são modpacks separados por baixo (mods/configs/servidor próprios),
  // mas para o jogador são UMA opção — "Hofheim" — no dropdown. A escolha do mundo acontece
  // nos cards logo abaixo, que só aparecem com o Hofheim selecionado.
  const worlds = modpacks.filter(m => m.world)
  const isWorldSelected = !!selectedModpackData?.world

  // Último mundo em que o jogador esteve: voltar de Vanilla para Hofheim devolve ele ao
  // mundo dele, não sempre ao Mundo 1.
  const lastWorldId = useRef(worlds[0]?.id)
  useEffect(() => {
    if (isWorldSelected) lastWorldId.current = selectedModpack
  }, [isWorldSelected, selectedModpack])

  // Lista do dropdown com os mundos colapsados numa entrada só, na posição do primeiro
  // mundo (mantém a ordem Vanilla → Hofheim → Hofheim Admin).
  const dropdownItems: { id: string; name: string; isWorldGroup?: boolean }[] = []
  for (const mp of modpacks) {
    if (mp.world) {
      if (!dropdownItems.some(i => i.isWorldGroup)) {
        dropdownItems.push({ id: '__Hofheim__', name: 'Hofheim', isWorldGroup: true })
      }
      continue
    }
    dropdownItems.push({ id: mp.id, name: mp.name })
  }

  function handlePickDropdown(item: { id: string; isWorldGroup?: boolean }) {
    setDropdownOpen(false)
    if (!item.isWorldGroup) {
      onModpackChange(item.id)
      return
    }
    // "Hofheim": mantém o mundo atual se já estiver num, senão volta pro último usado.
    if (isWorldSelected) return
    const target = worlds.find(w => w.id === lastWorldId.current)?.id || worlds[0]?.id
    if (target) onModpackChange(target)
  }

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <div className="logo-icon">
          <img src={logoImg} alt="Hofheim" className="logo-img" />
        </div>
        <div className="logo-text">
          <span className="logo-title">Hofheim</span>
          <span className="logo-subtitle">Valheim Server</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="sidebar-nav">
        <NavItem
          active={currentView === 'home'}
          onClick={() => onViewChange('home')}
          icon={<HomeIcon />}
          label="Início"
        />
        <NavItem
          active={currentView === 'mods'}
          onClick={() => onViewChange('mods')}
          icon={<ModsIcon />}
          label="Mods"
        />
        <NavItem
          active={currentView === 'settings'}
          onClick={() => onViewChange('settings')}
          icon={<SettingsIcon />}
          label="Configurações"
        />
        <NavItem
          active={currentView === 'about'}
          onClick={() => onViewChange('about')}
          icon={<InfoIcon />}
          label="Sobre o servidor"
        />
        {isAdmin && (
          <NavItem
            active={currentView === 'modpack-editor'}
            onClick={() => onViewChange('modpack-editor')}
            icon={<ModpackIcon />}
            label="Modpacks"
            accent
          />
        )}
        {isAdmin && (
          <NavItem
            active={currentView === 'admin'}
            onClick={() => onViewChange('admin')}
            icon={<AdminIcon />}
            label="Admin"
            accent
          />
        )}
      </nav>

      <div className="sidebar-divider" />

      {/* Modpack + Play */}
      <div className="sidebar-footer">
        <div className="modpack-selector">
          <label className="selector-label">Modpack</label>
          <div className="dropdown">
            <button
              className="dropdown-trigger"
              aria-expanded={dropdownOpen}
              onClick={() => setDropdownOpen(!dropdownOpen)}
            >
              <span>{isWorldSelected ? 'Hofheim' : selectedModpackData?.name || 'Selecionar...'}</span>
              <svg className="dropdown-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6,9 12,15 18,9" />
              </svg>
            </button>
            {dropdownOpen && (
              <div className="dropdown-menu">
                {dropdownItems.map(item => (
                  <button
                    key={item.id}
                    className={`dropdown-item ${item.isWorldGroup ? (isWorldSelected ? 'active' : '') : item.id === selectedModpack ? 'active' : ''}`}
                    onClick={() => handlePickDropdown(item)}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Escolha do mundo — só faz sentido com o Hofheim selecionado. */}
        {isWorldSelected && worlds.length > 1 && (
          <div className="world-selector">
            <label className="selector-label">Mundo</label>
            <div className="world-cards">
              {worlds.map((w, i) => {
                const active = w.id === selectedModpack
                return (
                  <button
                    key={w.id}
                    className={`world-card ${active ? 'active' : ''}`}
                    onClick={() => onModpackChange(w.id)}
                    title={`${w.name} — ${w.world!.tagline}`}
                    aria-pressed={active}
                  >
                    <span className="world-card-icon">{i === 0 ? <SwordIcon /> : <ShieldIcon />}</span>
                    <span className="world-card-name">{w.world!.label}</span>
                    <span className="world-card-tagline">{active ? 'Selecionado' : w.world!.tagline}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <button className="btn-play" onClick={onPlay} disabled={isPlaying}>
          {isPlaying ? (
            'Iniciando...'
          ) : (
            <>
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                <polygon points="5,3 19,12 5,21" />
              </svg>
              Jogar
            </>
          )}
        </button>

        {hasServerStatus && (
          <div className="sidebar-status">
            <div className={`sidebar-status-row ${serverChecking ? 'checking' : serverOnline ? 'online' : 'offline'}`}>
              <span className="sidebar-status-dot" />
              <span>Servidores: {serverChecking ? 'Verificando...' : serverOnline ? 'Online' : 'Offline'}</span>
            </div>
            {!serverChecking && (
              <span className="sidebar-status-players">Jogadores online: {serverPlayers ?? 0}/{serverMaxPlayers ?? 0}</span>
            )}
          </div>
        )}

        {modpackVersion && selectedModpack !== 'vanilla' && (
          <span className="version-label">v{modpackVersion}</span>
        )}
      </div>

      {/* Bottom links */}
      <div className="sidebar-links">
        <a className="sidebar-link" onClick={() => window.Hofheim.shell.openExternal(DISCORD_URL)} title="Discord">
          <DiscordIcon />
        </a>
        <a className="sidebar-link" onClick={() => window.Hofheim.shell.openExternal(WEBSITE_URL)} title="Instagram">
          <WebIcon />
        </a>
        <a className="sidebar-link" onClick={() => onViewChange('about')} title="Regras">
          <RulesIcon />
        </a>
      </div>
    </aside>
  )
}

function NavItem({ active, onClick, icon, label, accent }: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  accent?: boolean
}) {
  return (
    <button className={`nav-item ${active ? 'active' : ''} ${accent ? 'accent' : ''}`} onClick={onClick}>
      <span className="nav-icon">{icon}</span>
      <span>{label}</span>
      {active && <span className="nav-indicator" />}
    </button>
  )
}

/** Ícone do card do Mundo 1 — espada. */
function SwordIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 17.5 3 6V3h3l11.5 11.5" />
      <path d="m13 19 6-6" />
      <path d="m16 16 4 4" />
      <path d="m19 21 2-2" />
    </svg>
  )
}

/** Ícone do card do Mundo 2 — escudo com runa. */
function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s7-3.5 7-9V5l-7-3-7 3v8c0 5.5 7 9 7 9z" />
      <path d="M12 7v9" />
      <path d="m9 10 3-3 3 3" />
    </svg>
  )
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9,22 9,12 15,12 15,22" />
    </svg>
  )
}

function ModsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27,6.96 12,12.01 20.73,6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function ModpackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
      <path d="M9 8l3 3 3-3" />
      <line x1="12" y1="11" x2="12" y2="6" />
    </svg>
  )
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="11" />
      <circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

function AdminIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

function DiscordIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.032.055a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.11 13.11 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
    </svg>
  )
}

function WebIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="18" height="18">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}

function RulesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="18" height="18">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14,2 14,8 20,8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="16" y2="17" />
    </svg>
  )
}
