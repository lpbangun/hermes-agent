import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { translateBots } from './i18n-test-helper'

// Room bodies go through the shell's message renderer (the 1:1 chat's code
// card + `MEDIA:` transform) when the SDK exports it. The stub records what the
// room handed it so the test asserts the wiring, not the renderer's output.
vi.mock('@hermes/plugin-sdk', async () => {
  const { pluginSdkMock, createGroupGateway } = await import('./group-test-utils')
  const base = await pluginSdkMock(createGroupGateway().host)

  const Button = ({ children, ...props }: ComponentProps<'button'>) => <button {...props}>{children}</button>

  return {
    ...base,
    Button,
    RowButton: Button,
    cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
    Codicon: () => null,
    CopyButton: () => null,
    ConfirmDialog: () => null,
    Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    Input: (props: ComponentProps<'input'>) => <input {...props} />,
    MessageTextContent: ({ media = true, text }: { media?: boolean; text: string }) => (
      <span data-media={String(media)} data-testid="message-text-content">
        {text}
      </span>
    ),
    ToggleRow: ({
      checked,
      label,
      onChange
    }: {
      checked: boolean
      label: string
      onChange: (value: boolean) => void
    }) => (
      <label>
        <input checked={checked} onChange={event => onChange(event.target.checked)} type="checkbox" />
        {label}
      </label>
    ),
    Tip: ({ children }: { children: ReactNode }) => children,
    relativeTime: () => 'now',
    useI18n: () => ({ t: { common: { cancel: 'Cancel', save: 'Save' } } }),
    usePluginI18n: () => translateBots
  }
})
vi.mock('./avatar', () => ({ avatarColor: () => '#888', botAppearance: () => ({}), BotFace: () => null }))
vi.mock('./group-chat-parts', () => ({
  GroupClarifyCard: () => null,
  GroupImageControls: () => null,
  GroupMentionInput: () => null
}))
afterEach(cleanup)

it('saves a selected coordinator and preserves it across durable rehydration', async () => {
  Element.prototype.scrollIntoView = vi.fn()

  const [chat, shared, utils, { GroupChatWorkspace }] = await Promise.all([
    import('./group-chat'),
    import('./shared'),
    import('./group-test-utils'),
    import('./group-chat-view')
  ])

  const storage = new Map<string, unknown>()
  shared.setPluginCtx(utils.scriptedStorage(storage))
  const members = [{ name: 'research' }, { name: 'builder' }, { name: 'ops' }]
  chat.$groupChats.set({ Policy: { log: [], members, sessions: {}, watermarks: {} } })
  const view = render(<GroupChatWorkspace group="Policy" members={members} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Group settings for Policy' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Coordinator-led room' }))
  expect((screen.getByRole('combobox', { name: 'Coordinator' }) as HTMLSelectElement).value).toBe('research')
  fireEvent.change(screen.getByRole('combobox', { name: 'Coordinator' }), { target: { value: 'ops' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(chat.$groupChats.get().Policy).toMatchObject({ coordinatorMode: true, coordinatorKey: 'ops' })
  )
  view.unmount()
  const durable = storage.get('group-chats') as ReturnType<typeof chat.durableGroupChatRooms>
  chat.$groupChats.set({})
  chat.$groupChats.set(JSON.parse(JSON.stringify(durable)))
  render(<GroupChatWorkspace group="Policy" members={members} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Group settings for Policy' }))
  expect((screen.getByRole('checkbox', { name: 'Coordinator-led room' }) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByRole('combobox', { name: 'Coordinator' }) as HTMLSelectElement).value).toBe('ops')
  shared.setPluginCtx(null)
})

it('renders member replies through the shell message renderer, resolving media only for members on this gateway', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  const { $groupChats } = await import('./group-chat')
  const { GroupChatWorkspace } = await import('./group-chat-view')

  const log = [
    { id: 'u1', thread: 'a', from: { kind: 'user' as const, name: 'You' }, text: 'Show me', at: 1 },
    { id: 'm1', thread: 'a', from: { kind: 'member' as const, name: 'builder' }, text: 'MEDIA:/tmp/local.png', at: 2 },
    {
      id: 'm2',
      thread: 'a',
      from: { kind: 'member' as const, name: 'builder', source: 'mini' },
      text: 'MEDIA:/tmp/remote.png',
      at: 3
    }
  ]

  const members = [
    { name: 'builder' },
    { connectionId: 'mini', connectionLabel: 'mini', name: 'builder', remoteSource: true, sourceScoped: true }
  ] as never

  $groupChats.set({ Room: { log, watermarks: {}, sessions: {} } })
  const { getAllByTestId } = render(<GroupChatWorkspace group="Room" members={members} />)
  const bodies = getAllByTestId('message-text-content').map(el => [el.textContent, el.dataset.media])

  expect(bodies).toEqual([
    ['Show me', 'true'],
    ['MEDIA:/tmp/local.png', 'true'],
    ['MEDIA:/tmp/remote.png', 'false']
  ])
})

it('removes Stop controls from historical working rows after the room settles', async () => {
  Element.prototype.scrollIntoView = vi.fn()

  const [{ $groupChats }, activity, { GroupChatWorkspace }] = await Promise.all([
    import('./group-chat'),
    import('./group-activity'),
    import('./group-chat-view')
  ])

  $groupChats.set({
    Settled: {
      epoch: 1,
      log: [],
      members: [{ name: 'builder' }],
      running: false,
      sessions: {},
      watermarks: {}
    }
  })
  activity.recordGroupActivity('Settled', { kind: 'working', member: 'builder' })
  activity.recordGroupActivity('Settled', { kind: 'replied', member: 'builder' })
  activity.recordGroupActivity('Settled', { kind: 'settled', member: null })

  render(<GroupChatWorkspace group="Settled" members={[{ name: 'builder' }]} />)
  fireEvent.click(screen.getByRole('button', { name: /^Activity/ }))

  expect(screen.getByText('builder is working…')).toBeTruthy()
  expect(screen.getByText('builder replied')).toBeTruthy()
  expect(screen.getByText('turn settled')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
})
