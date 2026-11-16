import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from '../i18n'
import { pickOverlayStrings, shownPickLabel } from './strings'

afterEach(() => setLanguage('en'))

describe('Point & Edit’s words', () => {
  it('hands the page its words in Fabricator’s language, leaving the numbers to the page', async () => {
    await setLanguage('de')
    const strings = pickOverlayStrings()
    expect(strings.start).toBe('Klicke auf alles, was du ändern möchtest')
    expect(strings.roles.button).toBe('Schaltfläche')
    expect(strings.picked.one).toBe('{n} ausgewählt · sag im Chat, was sich ändern soll')
    expect(strings.tooMany).toBe('Du kannst bis zu {n} Elemente gleichzeitig auswählen')

    await setLanguage('es')
    expect(pickOverlayStrings().picked).toEqual({
      one: '{n} seleccionado · di en el chat qué cambiar',
      other: '{n} seleccionados · di en el chat qué cambiar'
    })
  })

  it('shows a pick’s label in Fabricator’s language, from its role and name', async () => {
    await setLanguage('de')
    expect(shownPickLabel({ label: 'Button · Save', role: 'button', name: 'Save' })).toBe(
      'Schaltfläche · Save'
    )
    // Picks from before the name was kept: the name is what follows the role.
    expect(shownPickLabel({ label: 'List item · Q3 · North', role: 'item' })).toBe(
      'Listeneintrag · Q3 · North'
    )
    expect(shownPickLabel({ label: 'Clip' })).toBe('Clip')
  })
})
