import './TitleBar.css'

interface Props {
  isAdmin: boolean
  onAdminClick: () => void
  username: string
}

export default function TitleBar({ isAdmin, onAdminClick, username }: Props) {
  return (
    <div className="titlebar">
      <div className="titlebar-drag" />

      <div className="titlebar-right">
        <div className="titlebar-user">
          {isAdmin && <span className="admin-badge">Admin</span>}
          <div className="user-avatar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </div>
          <span className="user-name">{username}</span>
          <button className="btn-admin" onClick={onAdminClick} title={isAdmin ? 'Sair do admin' : 'Login admin'}>
            {isAdmin ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16,17 21,12 16,7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            )}
          </button>
        </div>

        <div className="titlebar-sep" />

        <div className="titlebar-controls">
          <button className="control-btn" onClick={() => window.Hofheim.window.minimize()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button className="control-btn" onClick={() => window.Hofheim.window.maximize()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="5" y="5" width="14" height="14" rx="1.5" />
            </svg>
          </button>
          <button className="control-btn close" onClick={() => window.Hofheim.window.close()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
