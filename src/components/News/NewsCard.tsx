import { useEffect, useRef, useState } from 'react'
import './NewsCard.css'

export interface NewsItem {
  id: string
  type: 'update' | 'event' | 'announcement'
  category?: 'noticias' | 'eventos' | 'destaque'
  title: string
  date: string
  time?: string
  summary?: string
  image?: string
  link?: string
  pinned?: boolean
}

const CATEGORY_LABELS: Record<string, string> = {
  noticias: 'NOTÍCIAS',
  eventos: 'EVENTOS',
  destaque: 'DESTAQUE',
  update: 'NOTÍCIAS',
  event: 'EVENTOS',
  announcement: 'DESTAQUE',
}

interface Props {
  news: NewsItem | null
  categoryLabel?: string
}

export default function NewsCard({ news, categoryLabel }: Props) {
  const titleRef = useRef<HTMLParagraphElement>(null)
  const [titleOverflow, setTitleOverflow] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)

  // Detecta quando o título (agora em uma linha) não cabe, para decidir se mostra "ver mais".
  useEffect(() => {
    const el = titleRef.current
    if (!el) return
    const check = () => setTitleOverflow(el.scrollWidth > el.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [news?.title])

  // Fecha o modal com Esc.
  useEffect(() => {
    if (!modalOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setModalOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalOpen])

  function openLink() {
    if (news?.link) window.Hofheim.shell.openExternal(news.link)
  }

  const label =
    categoryLabel ||
    (news?.category ? CATEGORY_LABELS[news.category] : null) ||
    (news?.type ? CATEGORY_LABELS[news.type] : 'NOTÍCIAS')

  const formattedDate = news?.date
    ? new Date(news.date + 'T12:00:00').toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      })
    : ''

  // Há conteúdo além do que cabe no card (título cortado ou resumo) → abre modal.
  const expandable = titleOverflow || !!news?.summary
  const hasLink = !!news?.link
  const clickable = expandable || hasLink

  function handleCardClick() {
    if (expandable) setModalOpen(true)
    else if (hasLink) openLink()
  }

  return (
    <>
      <div className={`news-card ${clickable ? 'clickable' : ''}`} onClick={clickable ? handleCardClick : undefined}>
        <div className="news-card-label">{label}</div>
        <div
          className="news-card-image"
          style={news?.image ? { backgroundImage: `url(${news.image})` } : undefined}
        />
        <div className="news-card-footer">
          <p className="news-card-title" ref={titleRef}>{news?.title || ''}</p>
          <div className="news-card-bottom">
            <span className="news-card-date">{formattedDate}</span>
            {expandable ? (
              <span
                className="news-card-link"
                onClick={e => { e.stopPropagation(); setModalOpen(true) }}
              >
                ver mais
              </span>
            ) : (
              hasLink && <span className="news-card-link">Ler mais</span>
            )}
          </div>
        </div>
      </div>

      {modalOpen && (
        <div className="news-modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="news-modal" onClick={e => e.stopPropagation()}>
            <button className="news-modal-close" onClick={() => setModalOpen(false)} aria-label="Fechar">✕</button>
            {news?.image && (
              <div className="news-modal-image" style={{ backgroundImage: `url(${news.image})` }} />
            )}
            <div className="news-modal-body">
              <div className="news-card-label">{label}</div>
              <h3 className="news-modal-title">{news?.title}</h3>
              {news?.summary && <p className="news-modal-summary">{news.summary}</p>}
              <div className="news-modal-footer">
                <span className="news-card-date">{formattedDate}</span>
                {hasLink && (
                  <button className="news-modal-link" onClick={openLink}>Ler mais ↗</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
