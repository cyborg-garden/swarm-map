// @vitest-environment node
/**
 * The name of a new door agent. One function decides what a name becomes and
 * whether it is taken, and both the create form and the server call it: the
 * form to say so while the name is typed, the server to refuse.
 */
import { describe, it, expect } from 'vitest'
import { doorAgentName, doorNameProblem, DOOR_NAME_RULE } from '../door-agent-name'

describe('the name of a new door agent', () => {
  it('becomes a lower-case id of letters, digits and dashes', () => {
    expect(doorAgentName('Pi One')).toEqual({ name: 'pi-one', id: 'h_pi_one' })
    expect(doorAgentName('  garden-helper ')).toEqual({ name: 'garden-helper', id: 'h_garden_helper' })
    expect(doorAgentName('a  -  b')).toEqual({ name: 'a-b', id: 'h_a_b' })
  })

  it.each([undefined, null, 7, '', ' ', 'x', '-ab', '../up', 'a_b', 'naïve', 'a'.repeat(32), 'a\nb'])('refuses %j', (raw) => {
    expect(doorAgentName(raw)).toEqual({ error: `Name: ${DOOR_NAME_RULE[0].toLowerCase()}${DOOR_NAME_RULE.slice(1)}` })
  })

  it('takes the longest name the launcher takes, and no longer', () => {
    expect('name' in doorAgentName('a'.repeat(31))).toBe(true)
    expect('error' in doorAgentName('a'.repeat(32))).toBe(true)
  })

  const agents = [{ id: 'h_alpha', name: 'alpha' }, { id: 'h_pi_one', name: 'pi-one' }, { id: 'h_old_row' }]

  it('says nothing about a free name', () => {
    expect(doorNameProblem('beta', agents)).toBeUndefined()
  })

  it('says so when a Hermes agent or another door agent has the name', () => {
    expect(doorNameProblem('alpha', agents)).toBe('An agent named "alpha" already exists')
    expect(doorNameProblem('Pi One', agents)).toBe('An agent named "pi-one" already exists')
  })

  it('counts a name another agent goes by, whatever id that agent has', () => {
    expect(doorNameProblem('beta', [{ id: 'h_imported_1', name: 'beta' }])).toBe('An agent named "beta" already exists')
  })

  it('counts a name whose id another agent already has, however that agent is named', () => {
    expect(doorNameProblem('old-row', agents)).toBe('An agent named "old-row" already exists')
    // `a-b` and `a_b`-style ids fold to the same id.
    expect(doorNameProblem('pi one', [{ id: 'h_pi_one', name: 'something-else' }])).toBe('An agent named "pi-one" already exists')
  })

  it('gives the shape problem first', () => {
    expect(doorNameProblem('x', agents)).toMatch(/^Name: letters, digits, spaces and dashes/)
  })
})
