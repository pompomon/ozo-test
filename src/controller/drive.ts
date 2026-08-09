export interface WheelSpeeds {
  readonly left: number
  readonly right: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function normalizeWheelSpeeds(left: number, right: number): WheelSpeeds {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return { left: 0, right: 0 }
  }
  const scale = Math.max(1, Math.abs(left), Math.abs(right))
  return {
    left: clamp(left / scale, -1, 1),
    right: clamp(right / scale, -1, 1),
  }
}

export function mixJoystick(x: number, y: number, deadZone = 0.08): WheelSpeeds {
  if (![x, y, deadZone].every(Number.isFinite) || deadZone < 0 || deadZone >= 1) {
    return { left: 0, right: 0 }
  }
  const magnitude = Math.hypot(x, y)
  if (magnitude <= deadZone) {
    return { left: 0, right: 0 }
  }
  const limitedMagnitude = Math.min(1, magnitude)
  const scaledMagnitude = (limitedMagnitude - deadZone) / (1 - deadZone)
  const directionX = x / magnitude
  const directionY = y / magnitude
  return normalizeWheelSpeeds(
    (directionY + directionX) * scaledMagnitude,
    (directionY - directionX) * scaledMagnitude,
  )
}

export function normalizedToMillimetersPerSecond(
  wheels: WheelSpeeds,
  maximumSpeed: number,
): WheelSpeeds {
  const speed = clamp(maximumSpeed, 0, 300)
  return {
    left: clamp(wheels.left, -1, 1) * speed,
    right: clamp(wheels.right, -1, 1) * speed,
  }
}

