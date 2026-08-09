import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
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

  it('shows an actionable firmware update requirement for legacy Evo', async () => {
    const controller = new EvoController(new FakeTransport(LEGACY_PROFILE))
    controllers.push(controller)
    render(<App controller={controller} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose Evo' }))
    await screen.findByText('Firmware update required')
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
})
