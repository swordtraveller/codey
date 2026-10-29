import { Button, Menu, MenuDivider, MenuGroup, MenuGroupHeader, MenuItemRadio, MenuList, MenuPopover, MenuTrigger } from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import type { ListSortPreference } from '../../../shared/types'

export function ListSortMenu({ label, value, disabled, onChange }: {
  label: string
  value: ListSortPreference
  disabled?: boolean
  onChange: (value: ListSortPreference) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const nameSort = value.by === 'name'
  return (
    <Menu checkedValues={{ sortBy: [value.by], sortDirection: [value.direction] }} onCheckedValueChange={(_, data) => {
      const selected = data.checkedItems[0]
      if (data.name === 'sortBy' && (selected === 'name' || selected === 'activity' || selected === 'created') && selected !== value.by) {
        onChange({ by: selected, direction: selected === 'name' ? 'asc' : 'desc' })
      }
      if (data.name === 'sortDirection' && (selected === 'asc' || selected === 'desc') && selected !== value.direction) {
        onChange({ ...value, direction: selected })
      }
    }}>
      <MenuTrigger disableButtonEnhancement>
        <Button appearance="subtle" size="small" disabled={disabled} aria-label={t('sidebarSortList', { list: label })} title={t('sidebarSortList', { list: label })}>
          {t('sidebarSort')}
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuGroup>
            <MenuGroupHeader>{t('sidebarSortBy')}</MenuGroupHeader>
            <MenuItemRadio name="sortBy" value="name">{t('sidebarSortName')}</MenuItemRadio>
            <MenuItemRadio name="sortBy" value="activity">{t('sidebarSortActivity')}</MenuItemRadio>
            <MenuItemRadio name="sortBy" value="created">{t('sidebarSortCreated')}</MenuItemRadio>
          </MenuGroup>
          <MenuDivider />
          <MenuGroup>
            <MenuGroupHeader>{t('sidebarSortDirection')}</MenuGroupHeader>
            <MenuItemRadio name="sortDirection" value="asc">{t(nameSort ? 'sidebarSortAZ' : 'sidebarSortOldest')}</MenuItemRadio>
            <MenuItemRadio name="sortDirection" value="desc">{t(nameSort ? 'sidebarSortZA' : 'sidebarSortNewest')}</MenuItemRadio>
          </MenuGroup>
        </MenuList>
      </MenuPopover>
    </Menu>
  )
}
