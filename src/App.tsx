import { startTransition, useEffect, useRef, useState } from 'react'
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { Pane } from 'tweakpane'
import './Player.css'
import {
  calculateMouthOpenness,
  clamp,
  formatTimestamp,
  getErrorMessage,
  isAcceptedVideoFile,
} from './lib/mouth'

type CameraState = 'idle' | 'starting' | 'ready' | 'error'
type TrackerState = 'idle' | 'loading' | 'ready' | 'error'

type Settings = {
  autoplayOnLoad: boolean
  detectionCadenceMs: number
  hysteresis: number
  mirrorCameraPreview: boolean
  mouthControlEnabled: boolean
  openThreshold: number
  requirePlayback: boolean
  rewindIntervalMs: number
  rewindStepSec: number
  showCameraPreview: boolean
  smoothing: number
}

type RuntimeSnapshot = {
  currentTime: number
  duration: number
  faceVisible: boolean
  isRewinding: boolean
  mouthOpen: boolean
  progressToRewind: number
  rawOpenness: number
  rewinds: number
  smoothedOpenness: number
}

const DEFAULT_SETTINGS: Settings = {
  autoplayOnLoad: false,
  detectionCadenceMs: 40,
  hysteresis: 0.012,
  mirrorCameraPreview: true,
  mouthControlEnabled: true,
  openThreshold: 0.5,
  requirePlayback: true,
  rewindIntervalMs: 100,
  rewindStepSec: 1.2,
  showCameraPreview: true,
  smoothing: 0.72,
}

const DEFAULT_RUNTIME: RuntimeSnapshot = {
  currentTime: 0,
  duration: 0,
  faceVisible: false,
  isRewinding: false,
  mouthOpen: false,
  progressToRewind: 0,
  rawOpenness: 0,
  rewinds: 0,
  smoothedOpenness: 0,
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  return ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)
}

function App() {
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [cameraState, setCameraState] = useState<CameraState>('idle')
  const [isDragging, setIsDragging] = useState(false)
  const [isStageHovered, setIsStageHovered] = useState(false)
  const [paneVisible, setPaneVisible] = useState(false)
  const [runtime, setRuntime] = useState<RuntimeSnapshot>(DEFAULT_RUNTIME)
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [trackerError, setTrackerError] = useState<string | null>(null)
  const [trackerState, setTrackerState] = useState<TrackerState>('idle')
  const [videoError, setVideoError] = useState<string | null>(null)
  const [videoName, setVideoName] = useState<string | null>(null)
  const [videoSource, setVideoSource] = useState<string | null>(null)

  const cameraVideoRef = useRef<HTMLVideoElement | null>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const detectionRef = useRef({
    elapsedOpenMs: 0,
    faceVisible: false,
    isRewinding: false,
    lastDetectionAt: 0,
    lastUiUpdateAt: 0,
    mouthOpen: false,
    rawOpenness: 0,
    rewinds: 0,
    smoothedOpenness: 0,
  })
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const landmarkerPromiseRef = useRef<Promise<FaceLandmarker> | null>(null)
  const mouthPaneRef = useRef<Pane | null>(null)
  const objectUrlRef = useRef<string | null>(null)
  const paneContainerRef = useRef<HTMLDivElement | null>(null)
  const paneSettingsRef = useRef<Settings>({ ...DEFAULT_SETTINGS })
  const playerVideoRef = useRef<HTMLVideoElement | null>(null)
  const trackerRef = useRef<FaceLandmarker | null>(null)
  const settingsRef = useRef(settings)

  const cameraReady = cameraState === 'ready'
  const trackingReady = trackerState === 'ready'
  const meterMaximum = Math.max(settings.openThreshold * 2.2, 0.16)
  const transportProgress =
    runtime.duration > 0 ? clamp(runtime.currentTime / runtime.duration, 0, 1) : 0
  const transportVisible =
    Boolean(videoSource) && (paneVisible || isStageHovered || runtime.isRewinding)
  const utilityVisible = paneVisible || isStageHovered || !videoSource
  const showCameraPreview = settings.showCameraPreview && cameraState !== 'idle'
  const hasHiddenIssue = !paneVisible && Boolean(videoError || cameraError || trackerError)
  const previewMeterProgress = clamp(runtime.smoothedOpenness / meterMaximum, 0, 1)
  const previewThresholdProgress = clamp(settings.openThreshold / meterMaximum, 0, 1)

  async function ensureTracker() {
    if (trackerRef.current) {
      return trackerRef.current
    }

    if (landmarkerPromiseRef.current) {
      return landmarkerPromiseRef.current
    }

    setTrackerState('loading')
    setTrackerError(null)

    landmarkerPromiseRef.current = (async () => {
      const vision = await FilesetResolver.forVisionTasks('/wasm')
      const tracker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: '/models/face_landmarker.task',
        },
        minFaceDetectionConfidence: 0.45,
        minFacePresenceConfidence: 0.45,
        minTrackingConfidence: 0.45,
        numFaces: 1,
        runningMode: 'VIDEO',
      })

      trackerRef.current = tracker
      setTrackerState('ready')

      return tracker
    })().catch((error: unknown) => {
      trackerRef.current = null
      landmarkerPromiseRef.current = null
      setTrackerState('error')
      setTrackerError(getErrorMessage(error))
      throw error
    })

    return landmarkerPromiseRef.current
  }

  async function startCamera() {
    if (cameraState === 'starting') {
      return
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState('error')
      setCameraError('This browser does not expose camera access.')
      return
    }

    setCameraState('starting')
    setCameraError(null)

    try {
      await ensureTracker()

      if (!cameraStreamRef.current) {
        cameraStreamRef.current = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: 'user',
            height: { ideal: 720 },
            width: { ideal: 1280 },
          },
        })
      }

      const cameraVideo = cameraVideoRef.current

      if (!cameraVideo) {
        throw new Error('Camera preview element is not available.')
      }

      if (cameraVideo.srcObject !== cameraStreamRef.current) {
        cameraVideo.srcObject = cameraStreamRef.current
      }

      if (cameraVideo.readyState < 1) {
        await new Promise<void>((resolve) => {
          cameraVideo.addEventListener('loadedmetadata', () => resolve(), { once: true })
        })
      }

      await cameraVideo.play()
      setCameraState('ready')
    } catch (error) {
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((track) => track.stop())
        cameraStreamRef.current = null
      }

      setCameraState('error')
      setCameraError(getErrorMessage(error))
    }
  }

  function resetRuntime() {
    detectionRef.current = {
      elapsedOpenMs: 0,
      faceVisible: false,
      isRewinding: false,
      lastDetectionAt: 0,
      lastUiUpdateAt: 0,
      mouthOpen: false,
      rawOpenness: 0,
      rewinds: 0,
      smoothedOpenness: 0,
    }

    setRuntime((current) => ({
      ...DEFAULT_RUNTIME,
      currentTime: current.currentTime,
      duration: current.duration,
    }))
  }

  function loadVideoFile(file: File) {
    if (!isAcceptedVideoFile(file)) {
      setVideoError('Please drop an .mp4 or .mov video file.')
      return
    }

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }

    const url = URL.createObjectURL(file)
    objectUrlRef.current = url

    setVideoError(null)
    setVideoName(file.name)
    setVideoSource(url)
    resetRuntime()

    void startCamera()
  }

  function handleSelectedFile(file: File | null) {
    if (!file) {
      return
    }

    loadVideoFile(file)
  }

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    const container = paneContainerRef.current

    if (!container) {
      return
    }

    const paneSettings = paneSettingsRef.current
    const pane = new Pane({
      container,
      expanded: true,
      title: 'Debug',
    })

    pane.hidden = true
    mouthPaneRef.current = pane

    const rewindFolder = pane.addFolder({ expanded: true, title: 'Rewind' })
    rewindFolder.addBinding(paneSettings, 'mouthControlEnabled', { label: 'enabled' })
    rewindFolder.addBinding(paneSettings, 'openThreshold', {
      label: 'threshold',
      max: 0.2,
      min: 0.02,
      step: 0.001,
    })
    rewindFolder.addBinding(paneSettings, 'hysteresis', {
      label: 'hysteresis',
      max: 0.05,
      min: 0,
      step: 0.001,
    })
    rewindFolder.addBinding(paneSettings, 'smoothing', {
      label: 'smoothing',
      max: 0.95,
      min: 0,
      step: 0.01,
    })
    rewindFolder.addBinding(paneSettings, 'rewindIntervalMs', {
      label: 'interval ms',
      max: 2000,
      min: 100,
      step: 25,
    })
    rewindFolder.addBinding(paneSettings, 'rewindStepSec', {
      label: 'rewind sec',
      max: 5,
      min: 0.25,
      step: 0.05,
    })
    rewindFolder.addBinding(paneSettings, 'requirePlayback', {
      label: 'only while playing',
    })

    const trackingFolder = pane.addFolder({ expanded: false, title: 'Tracking' })
    trackingFolder.addBinding(paneSettings, 'detectionCadenceMs', {
      label: 'cadence ms',
      max: 250,
      min: 16,
      step: 1,
    })
    trackingFolder.addBinding(paneSettings, 'showCameraPreview', { label: 'show camera' })
    trackingFolder.addBinding(paneSettings, 'mirrorCameraPreview', { label: 'mirror preview' })
    trackingFolder.addBinding(paneSettings, 'autoplayOnLoad', { label: 'autoplay upload' })

    const resetButton = pane.addButton({ title: 'Reset defaults' })
    resetButton.on('click', () => {
      Object.assign(paneSettings, DEFAULT_SETTINGS)
      pane.refresh()
      settingsRef.current = { ...DEFAULT_SETTINGS }
      setSettings({ ...DEFAULT_SETTINGS })
    })

    pane.on('change', () => {
      const nextSettings = { ...paneSettings }
      settingsRef.current = nextSettings
      setSettings(nextSettings)
    })

    return () => {
      mouthPaneRef.current = null
      pane.dispose()
    }
  }, [])

  useEffect(() => {
    if (mouthPaneRef.current) {
      mouthPaneRef.current.hidden = !paneVisible
    }
  }, [paneVisible])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Slash' || event.repeat || isEditableTarget(event.target)) {
        return
      }

      event.preventDefault()
      setPaneVisible((visible) => !visible)
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  useEffect(() => {
    const playerVideo = playerVideoRef.current

    if (!playerVideo) {
      return
    }

    const syncTransport = () => {
      startTransition(() => {
        setRuntime((current) => ({
          ...current,
          currentTime: playerVideo.currentTime || 0,
          duration: Number.isFinite(playerVideo.duration) ? playerVideo.duration : 0,
        }))
      })
    }

    syncTransport()
    playerVideo.addEventListener('durationchange', syncTransport)
    playerVideo.addEventListener('loadedmetadata', syncTransport)
    playerVideo.addEventListener('pause', syncTransport)
    playerVideo.addEventListener('play', syncTransport)
    playerVideo.addEventListener('seeked', syncTransport)
    playerVideo.addEventListener('seeking', syncTransport)
    playerVideo.addEventListener('timeupdate', syncTransport)

    return () => {
      playerVideo.removeEventListener('durationchange', syncTransport)
      playerVideo.removeEventListener('loadedmetadata', syncTransport)
      playerVideo.removeEventListener('pause', syncTransport)
      playerVideo.removeEventListener('play', syncTransport)
      playerVideo.removeEventListener('seeked', syncTransport)
      playerVideo.removeEventListener('seeking', syncTransport)
      playerVideo.removeEventListener('timeupdate', syncTransport)
    }
  }, [videoSource])

  useEffect(() => {
    if (!cameraReady || !trackingReady) {
      return
    }

    let animationFrameId = 0
    let lastFrameAt = performance.now()
    let lastCameraTime = -1

    const tick = () => {
      const now = performance.now()
      const deltaMs = now - lastFrameAt
      lastFrameAt = now

      const detection = detectionRef.current
      const cameraVideo = cameraVideoRef.current
      const playerVideo = playerVideoRef.current
      const tracker = trackerRef.current
      const currentSettings = settingsRef.current
      let rewoundThisFrame = false

      const canApplyRewind =
        Boolean(playerVideo) &&
        currentSettings.mouthControlEnabled &&
        detection.faceVisible &&
        detection.mouthOpen &&
        (!currentSettings.requirePlayback ||
          Boolean(playerVideo && !playerVideo.paused && !playerVideo.ended))

      if (canApplyRewind && playerVideo) {
        detection.elapsedOpenMs += deltaMs

        while (detection.elapsedOpenMs >= currentSettings.rewindIntervalMs) {
          playerVideo.currentTime = Math.max(0, playerVideo.currentTime - currentSettings.rewindStepSec)
          detection.elapsedOpenMs -= currentSettings.rewindIntervalMs
          detection.rewinds += 1
          rewoundThisFrame = true
        }
      } else {
        detection.elapsedOpenMs = 0
      }

      if (
        cameraVideo &&
        tracker &&
        cameraVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        cameraVideo.currentTime !== lastCameraTime &&
        now - detection.lastDetectionAt >= currentSettings.detectionCadenceMs
      ) {
        detection.lastDetectionAt = now
        lastCameraTime = cameraVideo.currentTime

        const result = tracker.detectForVideo(cameraVideo, now)
        const landmarks = result.faceLandmarks[0]

        if (landmarks) {
          const rawOpenness = calculateMouthOpenness(landmarks)
          const smoothing = clamp(currentSettings.smoothing, 0, 0.98)
          const smoothedOpenness =
            detection.smoothedOpenness * smoothing + rawOpenness * (1 - smoothing)
          const threshold = detection.mouthOpen
            ? currentSettings.openThreshold - currentSettings.hysteresis
            : currentSettings.openThreshold

          detection.faceVisible = true
          detection.rawOpenness = rawOpenness
          detection.smoothedOpenness = smoothedOpenness
          detection.mouthOpen = currentSettings.mouthControlEnabled && smoothedOpenness >= threshold
        } else {
          detection.faceVisible = false
          detection.mouthOpen = false
          detection.rawOpenness = 0
          detection.smoothedOpenness *= 0.6
          detection.elapsedOpenMs = 0
        }
      }

      detection.isRewinding =
        canApplyRewind && (detection.elapsedOpenMs > 0 || rewoundThisFrame)

      if (now - detection.lastUiUpdateAt >= 80) {
        detection.lastUiUpdateAt = now

        startTransition(() => {
          setRuntime({
            currentTime: playerVideo?.currentTime ?? 0,
            duration:
              playerVideo && Number.isFinite(playerVideo.duration) ? playerVideo.duration : 0,
            faceVisible: detection.faceVisible,
            isRewinding: detection.isRewinding,
            mouthOpen: detection.mouthOpen,
            progressToRewind:
              currentSettings.rewindIntervalMs > 0
                ? clamp(detection.elapsedOpenMs / currentSettings.rewindIntervalMs, 0, 1)
                : 0,
            rawOpenness: detection.rawOpenness,
            rewinds: detection.rewinds,
            smoothedOpenness: detection.smoothedOpenness,
          })
        })
      }

      animationFrameId = window.requestAnimationFrame(tick)
    }

    animationFrameId = window.requestAnimationFrame(tick)

    return () => {
      window.cancelAnimationFrame(animationFrameId)
    }
  }, [cameraReady, trackingReady])

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
      }

      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((track) => track.stop())
      }

      trackerRef.current?.close()
    }
  }, [])

  useEffect(() => {
    const playerVideo = playerVideoRef.current

    if (!playerVideo || !videoSource || !settings.autoplayOnLoad) {
      return
    }

    void playerVideo.play().catch(() => {})
  }, [settings.autoplayOnLoad, videoSource])

  return (
    <main className="video-shell">
      <section
        className={`video-stage ${isDragging ? 'video-stage--dragging' : ''}`}
        onDragEnter={(event) => {
          event.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={(event) => {
          event.preventDefault()

          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setIsDragging(false)
          }
        }}
        onDragOver={(event) => {
          event.preventDefault()
          setIsDragging(true)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setIsDragging(false)
          handleSelectedFile(event.dataTransfer.files[0] ?? null)
        }}
        onMouseEnter={() => setIsStageHovered(true)}
        onMouseLeave={() => setIsStageHovered(false)}
      >
        {videoSource ? (
          <video
            ref={playerVideoRef}
            className="lesson-video"
            controls
            playsInline
            src={videoSource}
            onError={() => {
              setVideoError(
                'This file loaded, but the browser could not decode it. Some .mov codecs need to be re-exported as H.264.',
              )
            }}
          />
        ) : (
          <div className="empty-stage">
            <div className="empty-stage__card">
              <p className="empty-stage__eyebrow">Mouth-driven practice transport</p>
              <h1>Drop an `.mp4` or `.mov` lesson video.</h1>
              <p>
                Keep your hands on the guitar. Open your mouth to charge rewind. Press
                <kbd>/</kbd> when you want the tuning panel.
              </p>
              <div className="empty-stage__actions">
                <button
                  className="stage-button"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Upload video
                </button>
                <button
                  className="stage-button stage-button--ghost"
                  disabled={cameraState === 'starting'}
                  type="button"
                  onClick={() => void startCamera()}
                >
                  {cameraReady
                    ? 'Camera ready'
                    : cameraState === 'starting'
                      ? 'Starting camera'
                      : 'Enable camera'}
                </button>
              </div>
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          accept=".mov,.mp4,video/mp4,video/quicktime"
          className="visually-hidden"
          type="file"
          onChange={(event) => {
            handleSelectedFile(event.target.files?.[0] ?? null)
            event.target.value = ''
          }}
        />

        <div
          className={`stage-toolbar ${
            utilityVisible ? 'stage-toolbar--visible' : 'stage-toolbar--hidden'
          }`}
        >
          <div className="stage-toolbar__meta">
            {videoName ? (
              <span className="stage-chip">{videoName}</span>
            ) : (
              <span className="stage-chip stage-chip--muted">Drop video to begin</span>
            )}
          </div>
          <div className="stage-toolbar__actions">
            {!cameraReady && (
              <button
                className="stage-button stage-button--ghost"
                disabled={cameraState === 'starting'}
                type="button"
                onClick={() => void startCamera()}
              >
                {cameraState === 'starting' ? 'Starting camera' : 'Enable camera'}
              </button>
            )}
            <button
              className="stage-button stage-button--ghost"
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              {videoSource ? 'Replace video' : 'Upload video'}
            </button>
            <button
              className="stage-button stage-button--slash"
              type="button"
              onClick={() => setPaneVisible((visible) => !visible)}
            >
              <span>/</span>
              {paneVisible ? 'Hide debug' : 'Show debug'}
            </button>
          </div>
        </div>

        {videoSource && (
          <div
            className={`transport-overlay ${
              transportVisible ? 'transport-overlay--visible' : 'transport-overlay--hidden'
            } ${runtime.isRewinding ? 'transport-overlay--rewinding' : ''}`}
          >
            <div className="transport-overlay__labels">
              <span>{runtime.isRewinding ? 'Rewinding' : 'Position'}</span>
              <span>
                {formatTimestamp(runtime.currentTime)} / {formatTimestamp(runtime.duration)}
              </span>
            </div>
            <div className="transport-overlay__track" aria-hidden="true">
              <div
                className="transport-overlay__fill"
                style={{ width: `${transportProgress * 100}%` }}
              />
              <div
                className="transport-overlay__thumb"
                style={{ left: `${transportProgress * 100}%` }}
              />
            </div>
          </div>
        )}

        <div
          className={`camera-dock ${
            showCameraPreview ? 'camera-dock--visible' : 'camera-dock--hidden'
          }`}
        >
          <video
            ref={cameraVideoRef}
            autoPlay
            className={`camera-preview ${
              settings.mirrorCameraPreview ? 'camera-preview--mirrored' : ''
            }`}
            muted
            playsInline
          />
          <div className="camera-dock__meter" aria-hidden="true">
            <div
              className={`camera-dock__fill ${
                runtime.mouthOpen ? 'camera-dock__fill--active' : ''
              }`}
              style={{ width: `${previewMeterProgress * 100}%` }}
            />
            <div
              className="camera-dock__threshold"
              style={{ left: `${previewThresholdProgress * 100}%` }}
            />
          </div>
        </div>

        <div
          className={`debug-overlay ${
            paneVisible ? 'debug-overlay--visible' : 'debug-overlay--hidden'
          }`}
        >
          <div className="debug-overlay__metrics">
            <article className="debug-card">
              <p className="debug-card__label">Mouth openness</p>
              <div className="debug-card__value-row">
                <strong>{runtime.smoothedOpenness.toFixed(3)}</strong>
                <span>raw {runtime.rawOpenness.toFixed(3)}</span>
              </div>
              <div className="debug-meter">
                <div
                  className={`debug-meter__fill ${
                    runtime.mouthOpen ? 'debug-meter__fill--active' : ''
                  }`}
                  style={{ width: `${previewMeterProgress * 100}%` }}
                />
                <div
                  className="debug-meter__threshold"
                  style={{ left: `${previewThresholdProgress * 100}%` }}
                />
              </div>
              <p className="debug-card__hint">
                Threshold {settings.openThreshold.toFixed(3)} with{' '}
                {settings.hysteresis.toFixed(3)} hysteresis
              </p>
            </article>

            <article className="debug-card">
              <p className="debug-card__label">Rewind charge</p>
              <div className="debug-card__value-row">
                <strong>{Math.round(runtime.progressToRewind * 100)}%</strong>
                <span>
                  {settings.rewindStepSec.toFixed(2)}s every{' '}
                  {(settings.rewindIntervalMs / 1000).toFixed(2)}s
                </span>
              </div>
              <div className="debug-meter">
                <div
                  className="debug-meter__fill debug-meter__fill--active"
                  style={{ width: `${runtime.progressToRewind * 100}%` }}
                />
              </div>
              <p className="debug-card__hint">Total rewinds this load: {runtime.rewinds}</p>
            </article>
          </div>

          <div className="debug-overlay__controls">
            <div className="pane-host" ref={paneContainerRef} />
          </div>

          {(videoError || cameraError || trackerError) && (
            <div className="debug-overlay__errors">
              {videoError && <p>{videoError}</p>}
              {cameraError && <p>Camera: {cameraError}</p>}
              {trackerError && <p>MediaPipe: {trackerError}</p>}
            </div>
          )}
        </div>

        {hasHiddenIssue && (
          <button
            className="warning-pill"
            type="button"
            onClick={() => setPaneVisible(true)}
          >
            Open debug for error details
          </button>
        )}
      </section>
    </main>
  )
}

export default App
