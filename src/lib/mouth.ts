import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

const UPPER_INNER_LIP = 13
const LOWER_INNER_LIP = 14
const LEFT_MOUTH_CORNER = 61
const RIGHT_MOUTH_CORNER = 291

function distance(a: NormalizedLandmark, b: NormalizedLandmark) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function calculateMouthOpenness(landmarks: NormalizedLandmark[]) {
  if (landmarks.length <= RIGHT_MOUTH_CORNER) {
    return 0
  }

  const vertical = distance(landmarks[UPPER_INNER_LIP], landmarks[LOWER_INNER_LIP])
  const horizontal = Math.max(
    distance(landmarks[LEFT_MOUTH_CORNER], landmarks[RIGHT_MOUTH_CORNER]),
    0.0001,
  )

  return vertical / horizontal
}

export function formatTimestamp(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return '--:--'
  }

  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60)

  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return 'Something went wrong.'
}

export function isAcceptedVideoFile(file: File) {
  const normalizedName = file.name.toLowerCase()
  const normalizedType = file.type.toLowerCase()

  return (
    normalizedType === 'video/mp4' ||
    normalizedType === 'video/quicktime' ||
    normalizedName.endsWith('.mp4') ||
    normalizedName.endsWith('.mov')
  )
}
