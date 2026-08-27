import bannerImg from '../../assets/banner.jfif'
import './HeroBanner.css'

interface FeaturedNews {
  title: string
  subtitle?: string
  image?: string
  link?: string
  cta?: string
}

interface Props {
  featured?: FeaturedNews
  fallbackTitle?: string
  fallbackSubtitle?: string
}

export default function HeroBanner({ featured, fallbackTitle, fallbackSubtitle }: Props) {
  const image = featured?.image || bannerImg
  const title = featured?.title || fallbackTitle || 'MINI SÉRIE SEM MAPA!'
  const subtitle = featured?.subtitle || fallbackSubtitle
  const cta = featured?.cta
  const link = featured?.link

  function handleClick() {
    if (link) window.Hofheim.shell.openExternal(link)
  }

  return (
    <div
      className={`hero-banner${link ? ' hero-banner--clickable' : ''}`}
      onClick={link ? handleClick : undefined}
    >
      <div className="hero-bg" style={{ backgroundImage: `url(${image})` }} />
      <div className="hero-overlay" />
      <div className="hero-content">
        <h1 className="hero-title">{title}</h1>
        {subtitle && <p className="hero-subtitle">{subtitle}</p>}
        {cta && link && (
          <button
            className="hero-cta"
            onClick={e => { e.stopPropagation(); handleClick() }}
          >
            {cta}
          </button>
        )}
      </div>
    </div>
  )
}
