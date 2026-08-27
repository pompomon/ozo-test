import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'

interface JoystickProps {
  readonly disabled: boolean
  readonly onChange: (x: number, y: number) => void
}

interface Position {
  readonly x: number
  readonly y: number
}

export function Joystick({ disabled, onChange }: JoystickProps) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const activePointerRef = useRef<number | undefined>(undefined)
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 })
  const [active, setActive] = useState(false)

  const update = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const bounds = surfaceRef.current?.getBoundingClientRect()
      if (!bounds) return
      const radius = Math.min(bounds.width, bounds.height) / 2
      const rawX = (event.clientX - (bounds.left + bounds.width / 2)) / radius
      const rawY = -((event.clientY - (bounds.top + bounds.height / 2)) / radius)
      const magnitude = Math.hypot(rawX, rawY)
      const scale = Math.max(1, magnitude)
      const next = { x: rawX / scale, y: rawY / scale }
      setPosition(next)
      onChange(next.x, next.y)
    },
    [onChange],
  )

  const start = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled || activePointerRef.current !== undefined) return
    event.currentTarget.setPointerCapture(event.pointerId)
    activePointerRef.current = event.pointerId
    setActive(true)
    update(event)
  }

  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (active && event.currentTarget.hasPointerCapture(event.pointerId)) update(event)
  }

  const stop = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerId !== activePointerRef.current) return
    activePointerRef.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setActive(false)
    setPosition({ x: 0, y: 0 })
    onChange(0, 0)
  }

  useEffect(() => {
    if (!disabled) return
    const surface = surfaceRef.current
    const pointerId = activePointerRef.current
    activePointerRef.current = undefined
    setActive(false)
    setPosition({ x: 0, y: 0 })
    if (pointerId !== undefined && surface?.hasPointerCapture(pointerId)) {
      surface.releasePointerCapture(pointerId)
    }
  }, [disabled])

  return (
    <div
      ref={surfaceRef}
      className={`joystick${disabled ? ' joystick--disabled' : ''}`}
      role="application"
      aria-label="Drive joystick"
      aria-disabled={disabled}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
    >
      <span className="joystick__axis joystick__axis--horizontal" />
      <span className="joystick__axis joystick__axis--vertical" />
      <span
        className="joystick__thumb"
        style={{
          transform: `translate(calc(-50% + ${position.x * 74}px), calc(-50% + ${-position.y * 74}px))`,
        }}
      />
      <span className="joystick__label">{disabled ? 'Arm motors' : 'Drag to drive'}</span>
    </div>
  )
}
