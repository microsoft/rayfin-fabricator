import type { PickRole, PickStrings } from '@shared/pick'
import { translator } from '../i18n'

const ROLES: readonly PickRole[] = [
  'button',
  'link',
  'heading',
  'text',
  'image',
  'icon',
  'field',
  'card',
  'list',
  'item',
  'table',
  'chart',
  'nav',
  'header',
  'footer',
  'section',
  'container',
  'element'
]

/** The words Point & Edit shows in the preview, in Fabricator's language. */
export function pickOverlayStrings(): PickStrings {
  const t = translator('app')
  const roles = Object.fromEntries(ROLES.map((role) => [role, t(`pick.role.${role}`)])) as Record<
    PickRole,
    string
  >
  // The page fills in the number; i18next only chooses the plural form here.
  const picked = (count: number): string =>
    t('pick.overlay.picked', { count, replace: { count: '{n}' } })
  return {
    roles,
    start: t('pick.overlay.start'),
    picked: { one: picked(1), other: picked(2) },
    shift: t('touchUp.shiftKey'),
    clip: t('pick.overlay.clip'),
    keys: t('pick.overlay.keys'),
    done: t('pick.overlay.done'),
    doneTitle: t('pick.overlay.doneTitle'),
    drop: t('pick.overlay.drop'),
    tooMany: t('pick.overlay.tooMany', { replace: { n: '{n}' } }),
    clipAdded: t('pick.overlay.clipAdded')
  }
}

/**
 * A pick's label in Fabricator's language: its role's name, then its own
 * name. `label` (English, for Copilot) is the fallback for picks that don't
 * say their role.
 */
export function shownPickLabel(pick: { label: string; role?: PickRole; name?: string }): string {
  if (!pick.role || !ROLES.includes(pick.role)) return pick.label
  const at = pick.label.indexOf(' · ')
  const name = pick.name ?? (at >= 0 ? pick.label.slice(at + 3) : '')
  const role = translator('app')(`pick.role.${pick.role}`)
  return name ? `${role} · ${name}` : role
}
