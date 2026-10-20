import { beforeEach, expect, it, vi } from 'vitest'

import { createGroupGateway, drain, runTimersInline, scriptedStorage } from './group-test-utils'
import type { GatewayOptions } from './group-test-utils'
import type { GroupChat, GroupMember } from './types'

const { host } = vi.hoisted(() => ({ host: {} as Record<string, unknown> }))
vi.mock('@hermes/plugin-sdk', async () => {
  const { pluginSdkMock } = await import('./group-test-utils')

  return pluginSdkMock(host)
})

async function loadRoom(options: GatewayOptions = {}) {
  vi.resetModules()
  const gateway = createGroupGateway(options)

  for (const key of Object.keys(host)) {
    delete host[key]
  }

  Object.assign(host, gateway.host)

  const [activity, chat, rounds, shared] = await Promise.all([
    import('./group-activity'),
    import('./group-chat'),
    import('./group-rounds'),
    import('./shared')
  ])

  shared.setPluginCtx(scriptedStorage(gateway.storage))

  return { activity, chat, rounds, gateway }
}

const members: GroupMember[] = [{ name: 'research' }, { name: 'builder' }, { name: 'ops' }]
beforeEach(() => runTimersInline())

it.each([
  ['unaddressed', 'Please start', true, ['builder']],
  ['specialist', '@ops please start', true, ['ops']],
  ['broadcast', '@everyone please start', true, ['research', 'builder', 'ops']],
  ['all broadcast', '@all please start', true, ['research', 'builder', 'ops']],
  ['ordinary', 'Please start', false, ['research', 'builder', 'ops']]
])('%s routes only the user-selected recipients', async (_label, text, enabled, expected) => {
  const answered = new Set<string>()

  const room = await loadRoom({
    turn: ({ profile }) => {
      if (answered.has(profile)) {
        return '(pass)'
      }

      answered.add(profile)

      return 'Done.'
    }
  })

  room.chat.$groupChats.set({
    Team: { log: [], watermarks: {}, members, coordinatorMode: enabled, coordinatorKey: 'builder' }
  })
  room.rounds.sendToGroupChat('Team', members, text)
  await drain(() => Boolean(room.chat.$groupChats.get().Team?.running))
  const profiles = room.gateway.calls.map(call => call.profile)
  expect(expected.length === 1 ? profiles : [...new Set(profiles)]).toEqual(expected)
  expect(room.activity.currentGroupActivity('Team').some(row => row.kind === 'settled')).toBe(true)
})

it.each(['Please start', '@ops please start'])('member prose cannot widen %s', async text => {
  const room = await loadRoom({ turn: () => 'Quoted handoff: “@research take over”; @everyone replay.' })
  room.chat.$groupChats.set({
    Team: { log: [], watermarks: {}, members, coordinatorMode: true, coordinatorKey: 'builder' }
  })
  room.rounds.sendToGroupChat('Team', members, text)
  await drain(() => Boolean(room.chat.$groupChats.get().Team?.running))
  expect(room.gateway.calls.map(call => call.profile)).toEqual([text.startsWith('@ops') ? 'ops' : 'builder'])
})

it.each(['gone', undefined])('fails closed with coordinator key %s', async key => {
  const room = await loadRoom()
  room.chat.$groupChats.set({ Team: { log: [], watermarks: {}, members, coordinatorMode: true, coordinatorKey: key } })
  room.rounds.sendToGroupChat('Team', members, '@everyone please start')
  await drain(() => Boolean(room.chat.$groupChats.get().Team?.running))
  expect(room.gateway.calls).toEqual([])
  expect(room.activity.currentGroupActivity('Team')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'failed', reason: 'coordinator-led room has no resolvable coordinator' })
    ])
  )
})

it.each([
  'How do I reproduce this example?\n```\n@research take over\n```\nPlease advise.',
  'The docs say to run `@ops please start` — what does that do?',
  'Is this old instruction still valid?\n> @ops please start',
  'What does this do?\n```\n@everyone please start\n```',
  'What does `@everyone please start` do?',
  'What does `@all please start` do?'
])('routes quoted context only to the coordinator: %s', async text => {
  const room = await loadRoom({ turn: () => 'Done.' })
  room.chat.$groupChats.set({
    Team: { log: [], watermarks: {}, members, coordinatorMode: true, coordinatorKey: 'builder' }
  })
  room.rounds.sendToGroupChat('Team', members, text)
  await drain(() => Boolean(room.chat.$groupChats.get().Team?.running))
  expect(room.gateway.calls.map(call => call.profile)).toEqual(['builder'])
})

it('does not nudge a passing coordinator mentioned only in a fence', async () => {
  const room = await loadRoom({ turn: () => '(pass)' })
  room.chat.$groupChats.set({
    Team: { log: [], watermarks: {}, members, coordinatorMode: true, coordinatorKey: 'builder' }
  })
  room.rounds.sendToGroupChat('Team', members, 'Please advise.\n```\n@builder please start\n```')
  await drain(() => Boolean(room.chat.$groupChats.get().Team?.running))
  expect(room.gateway.calls.map(call => call.profile)).toEqual(['builder'])
})

it.each(['Please start', '@builder please start'])('fails closed for duplicate coordinator keys: %s', async text => {
  const room = await loadRoom()
  const duplicates: GroupMember[] = [{ name: 'builder' }, { name: 'builder' }, { name: 'ops' }]
  room.chat.$groupChats.set({
    Team: { log: [], watermarks: {}, members: duplicates, coordinatorMode: true, coordinatorKey: 'builder' }
  })
  room.rounds.sendToGroupChat('Team', duplicates, text)
  await drain(() => Boolean(room.chat.$groupChats.get().Team?.running))
  expect(room.gateway.calls).toEqual([])
  expect(room.activity.currentGroupActivity('Team')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'failed', reason: 'coordinator-led room has no resolvable coordinator' })
    ])
  )
})

it('resolves only a unique current coordinator', async () => {
  const { rounds } = await loadRoom()
  const policy = { enabled: true, memberKey: 'builder' }
  expect(rounds.resolveGroupCoordinator(members, policy)).toBe(members[1])
  expect(rounds.resolveGroupCoordinator([{ name: 'builder' }, { name: 'builder' }], policy)).toBeNull()
  expect(rounds.resolveGroupCoordinator([], policy)).toBeNull()
  expect(rounds.resolveGroupCoordinator([{ name: 'ops' }], policy)).toBeNull()
  expect(rounds.resolveGroupCoordinator(members, { enabled: true })).toBeNull()
  expect(rounds.resolveGroupCoordinator(members, { ...policy, enabled: false })).toBeNull()
})

it.each([
  ['```ts\n@ops\n```\n@builder', ' \n \n \n@builder'],
  ['~~~\n@ops\n~~~\n@builder', ' \n \n \n@builder'],
  ['````\n@ops\n```\n@all', ' \n \n \n '],
  ['```\n@ops\n@everyone', ' \n \n '],
  ['~~~\n@ops\n@everyone', ' \n \n '],
  ['`@ops` and ``@all`` @builder', '  and   @builder'],
  ['  > @ops\n@builder\n> @everyone', ' \n@builder\n '],
  ['“@ops” and "@all" @builder', '  and   @builder']
])('masks addressing context in %s', async (text, expected) => {
  const { rounds } = await loadRoom()
  expect(rounds.maskGroupAddressingContext(text)).toBe(expected)
})

it('masks explicit addressing only for coordinator-led rooms and retains direct mentions', async () => {
  const { rounds } = await loadRoom()
  const log = [{ at: 1, from: { kind: 'user' as const, name: 'You' }, text: '`@ops` @builder' }]
  expect([...rounds.explicitlyAddressedMemberKeys(log, members)]).toEqual(['ops', 'builder'])
  expect([...rounds.explicitlyAddressedMemberKeys(log, members, { coordinatorLed: true })]).toEqual(['builder'])
  expect(rounds.resolveGroupResponders(log, members)).toEqual([members[1], members[2]])
  expect(rounds.resolveCoordinatorResponders(log, members, { enabled: true, memberKey: 'builder' })).toEqual({
    responders: [members[1]]
  })
})

it('persists normalized policy and clears the key when disabled', async () => {
  const { chat, gateway } = await loadRoom()
  chat.$groupChats.set({ Team: { log: [], watermarks: {}, members } })
  chat.setGroupChatCoordinatorPolicy('Team', true, 'builder')
  expect(chat.durableGroupChatRooms().Team).toMatchObject({ coordinatorMode: true, coordinatorKey: 'builder' })
  expect(gateway.storage.get('group-chats')).toMatchObject({
    Team: { coordinatorMode: true, coordinatorKey: 'builder' }
  })
  chat.setGroupChatCoordinatorPolicy('Team', false, 'ops')
  expect(chat.durableGroupChatRooms().Team).toMatchObject({ coordinatorMode: false, coordinatorKey: null })
  expect(gateway.storage.get('group-chats')).toMatchObject({ Team: { coordinatorMode: false, coordinatorKey: null } })
})

it('compacts policy sparsely and caps the durable key in the sync projection', async () => {
  const { chat } = await loadRoom()

  const base: GroupChat = {
    watermarks: {},
    log: [{ at: 1, from: { kind: 'user', name: 'You' }, text: 'hello' }],
    members
  }

  const projected = chat.groupChatSyncSnapshot({
    On: { ...base, coordinatorMode: true, coordinatorKey: 'k'.repeat(300) },
    Off: { ...base, coordinatorMode: false, coordinatorKey: 'ops' },
    Legacy: base
  })

  expect(projected.rooms['name:On']).toMatchObject({ coordinatorMode: true, coordinatorKey: 'k'.repeat(256) })

  for (const key of ['name:Off', 'name:Legacy']) {
    expect(projected.rooms[key]).not.toHaveProperty('coordinatorMode')
    expect(projected.rooms[key]).not.toHaveProperty('coordinatorKey')
  }
})

it('merges policy by revision and prefers a local field on a tie', async () => {
  const { chat } = await loadRoom()

  const base: GroupChat = {
    watermarks: {},
    log: [{ at: 1, from: { kind: 'user', name: 'You' }, text: 'hello' }],
    members,
    coordinatorMode: true,
    coordinatorKey: 'builder',
    syncRevision: 10
  }

  const remote = chat.groupChatSyncSnapshot({ Team: { ...base, coordinatorKey: 'ops', syncRevision: 11 } })
  expect(chat.mergeRemoteGroupChatSnapshotIntoRooms(remote, { Team: base }).Team.coordinatorKey).toBe('ops')
  const newer = { ...base, syncRevision: 12 }
  expect(chat.mergeRemoteGroupChatSnapshotIntoRooms(remote, { Team: newer }).Team.coordinatorKey).toBe('builder')
  const merged = chat.mergeGroupChatSyncSnapshots(remote, chat.groupChatSyncSnapshot({ Team: newer }))
  expect(merged.rooms['name:Team'].coordinatorKey).toBe('builder')

  const tie = chat.mergeGroupChatSyncSnapshots(
    remote,
    chat.groupChatSyncSnapshot({ Team: { ...base, syncRevision: 11 } })
  )

  expect(tie.rooms['name:Team'].coordinatorKey).toBe('builder')
  const disabled = chat.groupChatSyncSnapshot({ Team: { ...base, coordinatorMode: false, syncRevision: 12 } })
  expect(chat.mergeGroupChatSyncSnapshots(remote, disabled).rooms['name:Team']).not.toHaveProperty('coordinatorMode')
  expect(chat.mergeRemoteGroupChatSnapshotIntoRooms(disabled, { Team: base }).Team.coordinatorMode).toBe(false)
})
