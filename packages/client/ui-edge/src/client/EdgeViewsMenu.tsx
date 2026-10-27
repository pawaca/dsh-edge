/** Folded Conversation Views in the Conversation header's More menu. */
import { IconCheckOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** One View outside the header tabs, as the Conversation header lists it. */
export interface EdgeFoldedView {
  readonly id: string
  readonly label: string
  readonly active?: boolean
}

/** The fields the Conversation header gives each `conversation.session.header.views.actions` row. */
export interface EdgeViewsMenuProps extends PropsLocale<'settings.edge'> {
  readonly entries: readonly EdgeFoldedView[]
  readonly onOpen: (id: string) => void
  readonly onDismiss: () => void
}

/**
 * Upstream's `dsh-client-ui-entry-customization` fills this menu with the
 * folded Views followed by plugin browsing and a Creator draft. The Edge has
 * neither a plugin page nor the Creator preset, so it lists only the folded
 * Views: without a registration the header shows no More button, and a View
 * that does not fit the tab row could not be opened.
 * @param props - The header's folded Views, open and dismiss callbacks, and localized copy.
 * @returns Menu rows for the More conversation views menu.
 */
export function EdgeViewsMenu({ entries, onOpen, onDismiss, t }: EdgeViewsMenuProps) {
  if (entries.length === 0) {
    return <MenuItemButton disabled onSelect={() => {}}>{t('viewsMenuEmpty')}</MenuItemButton>
  }
  return <>
    {entries.map(entry => <MenuItemButton key={entry.id} current={entry.active === true}
      icon={entry.active === true ? <IconCheckOutlineRegular size={16} /> : undefined}
      onSelect={() => { onDismiss(); onOpen(entry.id) }}>
      {entry.label}
    </MenuItemButton>)}
  </>
}
