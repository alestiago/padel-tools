export function seekToFrame(video: HTMLVideoElement, frame: number, fps: number): Promise<void> {
  return new Promise((resolve) => {
    const t = frame / fps
    if (Math.abs(video.currentTime - t) < 0.001 / fps) {
      resolve()
      return
    }
    const handler = () => {
      video.removeEventListener('seeked', handler)
      resolve()
    }
    video.addEventListener('seeked', handler)
    video.currentTime = t
  })
}
