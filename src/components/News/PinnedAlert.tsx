import './PinnedAlert.css'

interface Props {
  text: string
  link?: string
}

export default function PinnedAlert({ text, link }: Props) {
  function handleLink() {
    if (link) window.Hofheim.shell.openExternal(link)
  }

  return (
    <div className="pinned-alert">
      <div className="pinned-alert-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
      </div>
      <span className="pinned-label">Últimas notícias</span>
      <span className="pinned-alert-text">{text}</span>
      {link && (
        <button className="pinned-alert-ver-todas" onClick={handleLink}>
          Ver todas
        </button>
      )}
    </div>
  )
}
