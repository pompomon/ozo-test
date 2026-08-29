import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BehaviorRuntime } from './behavior/BehaviorRuntime.ts'
import { EvoController } from './controller/EvoController.ts'
import { EVO_3_PROFILE, LEGACY_PROFILE } from './protocol/profile.ts'
import { readMessageId } from './protocol/modernCodec.ts'
import { FakeTransport, createModernResponder } from './test/FakeTransport.ts'
import App from './App.tsx'

const controllers: EvoController[] = []

afterEach(async () => {
  cleanup()
  for (const controller of controllers.splice(0)) {
    await controller.disconnect()
  }
})

describe('Evo Control UI', () => {
  it('connects, exposes controls, arms, handles keyboard drive, and stops', async () => {
    const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder())
    const controller = new EvoController(transport)
    controllers.push(controller)
    render(<App controller={controller} />)

    fireEvent.click(screen.getByRole('button', { name: 'Choose Evo' }))
    await screen.findByText('Connected · safe')
    expect(screen.getAllByText(/firmware 3.7.4/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText('0%').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Arm motors' }))
    await screen.findByRole('button', { name: 'Disarm' })
    fireEvent.keyDown(window, { key: 'w' })
    await waitFor(() => {
      expect(transport.writes.some((write) => readMessageId(write.data) === 104)).toBe(true)
    })
    fireEvent.keyUp(window, { key: 'w' })

    const leftWheel = screen.getByRole('slider', { name: 'Left' })
    fireEvent.change(leftWheel, { target: { value: '50' } })
    expect(leftWheel).toHaveValue('50')
    fireEvent.keyUp(leftWheel, { key: 'ArrowRight' })
    expect(leftWheel).toHaveValue('0')

    fireEvent.click(screen.getByRole('button', { name: 'Emergency stop' }))
    await screen.findByRole('button', { name: 'Arm motors' })
  })

  it('shows an actionable unsupported profile message for legacy Evo', async () => {
    const controller = new EvoController(new FakeTransport(LEGACY_PROFILE))
    controllers.push(controller)
    render(<App controller={controller} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose Evo' }))
    await screen.findByText('Unsupported firmware')
    expect(screen.getByText(/Missing sound, battery, firmware, telemetry/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Arm motors' })).toBeDisabled()
  })

  it('renders all touch control sections at a mobile viewport', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const controller = new EvoController(new FakeTransport(EVO_3_PROFILE, createModernResponder()))
    controllers.push(controller)
    render(<App controller={controller} />)
    expect(screen.getByRole('heading', { name: 'Drive' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Wheels' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Lights' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sound' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Telemetry' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Autonomous behavior' })).toBeInTheDocument()
  })

  it('gives autonomous behavior exclusive control until manual mode is restored', async () => {
    const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder())
    const controller = new EvoController(transport)
    controllers.push(controller)
    render(<App controller={controller} />)

    fireEvent.click(screen.getByRole('button', { name: 'Choose Evo' }))
    await screen.findByText('Connected · safe')
    fireEvent.click(screen.getByRole('button', { name: 'Arm motors' }))
    const enablePersonality = await screen.findByRole('button', { name: 'Enable personality' })
    await waitFor(() => expect(enablePersonality).toBeEnabled())
    fireEvent.click(enablePersonality)
    expect(await screen.findByText('Autonomous')).toHaveAttribute('role', 'status')

    expect(screen.getByRole('application', { name: 'Drive joystick' }))
      .toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('application', { name: 'Drive joystick' })).toHaveTextContent('Return to manual')
    expect(screen.getByRole('button', { name: 'Apply lights' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Dance' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Return to manual' }))
    await screen.findByText('Manual control')
    await waitFor(() => {
      expect(screen.getByRole('application', { name: 'Drive joystick' }))
        .toHaveAttribute('aria-disabled', 'false')
    })
    expect(screen.getByRole('button', { name: 'Apply lights' })).toBeEnabled()
  })

  it('keeps emergency stop available in an error state', async () => {
    const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder())
    const controller = new EvoController(transport)
    controllers.push(controller)
    render(<App controller={controller} />)

    transport.simulateDisconnect()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Emergency stop' })).toBeEnabled()
    })
  })

  it('stays connected while motor arming is pending', async () => {
    const controller = new EvoController(
      new FakeTransport(EVO_3_PROFILE, createModernResponder()),
    )
    controllers.push(controller)
    await controller.connect()
    const previousWakeLock = navigator.wakeLock
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request: vi.fn(() => new Promise(() => undefined)) },
    })

    try {
      render(<App controller={controller} />)
      fireEvent.click(screen.getByRole('button', { name: 'Arm motors' }))

      expect(await screen.findByText('Arming motors')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Emergency stop' })).toBeEnabled()
    } finally {
      if (previousWakeLock === undefined) {
        Reflect.deleteProperty(navigator, 'wakeLock')
      } else {
        Object.defineProperty(navigator, 'wakeLock', {
          configurable: true,
          value: previousWakeLock,
        })
      }
    }
  })

  it('triggers keyboard emergency stop while arming', async () => {
    const controller = new EvoController(
      new FakeTransport(EVO_3_PROFILE, createModernResponder()),
    )
    const runtime = new BehaviorRuntime(controller)
    const previousWakeLock = navigator.wakeLock
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request: vi.fn(() => new Promise(() => undefined)) },
    })
    controllers.push(controller)
    await controller.connect()

    try {
      const emergencyStop = vi.spyOn(runtime, 'emergencyStop')
      render(<App controller={controller} behaviorRuntime={runtime} />)
      fireEvent.click(screen.getByRole('button', { name: 'Arm motors' }))

      expect(await screen.findByText('Arming motors')).toBeInTheDocument()
      fireEvent.keyDown(window, { key: ' ' })

      await waitFor(() => {
        expect(emergencyStop).toHaveBeenCalledWith('Emergency stop pressed with Space')
      })
    } finally {
      if (previousWakeLock === undefined) {
        Reflect.deleteProperty(navigator, 'wakeLock')
      } else {
        Object.defineProperty(navigator, 'wakeLock', {
          configurable: true,
          value: previousWakeLock,
        })
      }
    }
  })

  it('reports keyboard emergency-stop failures', async () => {
    const controller = new EvoController(
      new FakeTransport(EVO_3_PROFILE, createModernResponder()),
    )
    const runtime = new BehaviorRuntime(controller)
    controllers.push(controller)
    await controller.connect()
    await controller.arm()
    vi.spyOn(runtime, 'emergencyStop').mockRejectedValue(new Error('Stop failed'))
    render(<App controller={controller} behaviorRuntime={runtime} />)

    fireEvent.keyDown(window, { key: ' ' })

    expect(await screen.findByRole('alert')).toHaveTextContent('Stop failed')
  })
})
