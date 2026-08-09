export const MODERN_SERVICE_UUID = '8903136c-5f13-4548-a885-c58779136801'
export const MODERN_CONTROL_UUID = '8903136c-5f13-4548-a885-c58779136802'

export const LEGACY_SERVICE_UUID = '8903136c-5f13-4548-a885-c58779136701'
export const LEGACY_DRIVE_UUID = '8903136c-5f13-4548-a885-c58779136702'
export const LEGACY_CONTROL_UUID = '8903136c-5f13-4548-a885-c58779136703'

export type Capability = 'movement' | 'lights' | 'sound' | 'battery' | 'firmware' | 'telemetry'

export interface ProtocolProfile {
  readonly id: 'evo-3' | 'legacy'
  readonly label: string
  readonly serviceUuid: string
  readonly capabilities: Readonly<Record<Capability, boolean>>
  readonly verified: boolean
  readonly compatibilityMessage?: string
}

export const EVO_3_PROFILE: ProtocolProfile = {
  id: 'evo-3',
  label: 'Evo firmware 3.x control service',
  serviceUuid: MODERN_SERVICE_UUID,
  capabilities: {
    movement: true,
    lights: true,
    sound: true,
    battery: true,
    firmware: true,
    telemetry: true,
  },
  verified: false,
}

export const LEGACY_PROFILE: ProtocolProfile = {
  id: 'legacy',
  label: 'Legacy Evo service',
  serviceUuid: LEGACY_SERVICE_UUID,
  capabilities: {
    movement: true,
    lights: true,
    sound: false,
    battery: false,
    firmware: false,
    telemetry: false,
  },
  verified: false,
  compatibilityMessage:
    'This legacy firmware does not expose every required feature. Update Evo with the official app before enabling motors.',
}

export const REQUIRED_CAPABILITIES: readonly Capability[] = [
  'movement',
  'lights',
  'sound',
  'battery',
  'firmware',
  'telemetry',
]

export function missingCapabilities(profile: ProtocolProfile): Capability[] {
  return REQUIRED_CAPABILITIES.filter((capability) => !profile.capabilities[capability])
}

export function isFullyCompatible(profile: ProtocolProfile): boolean {
  return missingCapabilities(profile).length === 0
}

