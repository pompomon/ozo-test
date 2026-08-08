import '@testing-library/jest-dom/vitest'

Object.defineProperty(globalThis, 'isSecureContext', {
  configurable: true,
  value: true,
})

Object.defineProperty(navigator, 'bluetooth', {
  configurable: true,
  value: {
    requestDevice: () => Promise.reject(new DOMException('No device selected', 'NotFoundError')),
  },
})
