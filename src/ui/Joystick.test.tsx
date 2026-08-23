import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Joystick } from './Joystick.tsx'

function pointerEvent(type: string, pointerId: number, clientX: number, clientY: number): Event {
  const event = new Event(type, { bubbles: true })
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: clientY },
  })
  return event
}

describe('Joystick', () => {
  it('releases pointer ownership and ignores movement when disabled', () => {
    const onChange = vi.fn()
    const { rerender } = render(<Joystick disabled={false} onChange={onChange} />)
    const joystick = screen.getByRole('application', { name: 'Drive joystick' })
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    Object.assign(joystick, {
      setPointerCapture,
      hasPointerCapture: () => true,
      releasePointerCapture,
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 200,
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        toJSON: () => undefined,
      }),
    })

    fireEvent(joystick, pointerEvent('pointerdown', 7, 100, 20))
    expect(setPointerCapture).toHaveBeenCalledWith(7)
    expect(onChange).toHaveBeenCalled()

    rerender(<Joystick disabled onChange={onChange} />)
    expect(releasePointerCapture).toHaveBeenCalledWith(7)
    const callsAfterDisable = onChange.mock.calls.length
    fireEvent(joystick, pointerEvent('pointermove', 7, 100, 10))
    expect(onChange).toHaveBeenCalledTimes(callsAfterDisable)
  })
})
