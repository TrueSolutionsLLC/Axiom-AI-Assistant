import { useCallback, useEffect, useRef, useState } from 'react';
import { FaceLandmarker, FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

export type TrackingStatus = 'off' | 'starting' | 'searching' | 'locked' | 'lost' | 'denied' | 'busy' | 'error';

export interface TrackingPose {
  x: number;
  y: number;
  yaw: number;
  pitch: number;
  roll: number;
  gazeX: number;
  gazeY: number;
  blinkLeft: number;
  blinkRight: number;
  distance: number;
  confidence: number;
  lastSeen: number;
  source: 'none' | 'face' | 'body';
  fps: number;
  motion: number;
  // Normalized (0-1) bounding box in raw, unmirrored camera image space —
  // draws identically over the live video and any canvas overlay sharing
  // the same CSS transform, no separate mirroring math needed.
  box?: { x: number; y: number; width: number; height: number };
}

export const boundingBox = (points: Array<{ x: number; y: number; visibility?: number }>, padX: number, padYTop: number, padYBottom: number) => {
  let minX = 1, maxX = 0, minY = 1, maxY = 0, found = false;
  for (const point of points) {
    if (point.visibility !== undefined && point.visibility < 0.3) continue;
    found = true;
    if (point.x < minX) minX = point.x; if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y; if (point.y > maxY) maxY = point.y;
  }
  if (!found) return undefined;
  const spanX = maxX - minX, spanY = maxY - minY;
  const x = Math.max(0, minX - spanX * padX), x2 = Math.min(1, maxX + spanX * padX);
  const y = Math.max(0, minY - spanY * padYTop), y2 = Math.min(1, maxY + spanY * padYBottom);
  return { x, y, width: x2 - x, height: y2 - y };
};

const neutralPose: TrackingPose = { x: 0, y: 0, yaw: 0, pitch: 0, roll: 0, gazeX: 0, gazeY: 0, blinkLeft: 1, blinkRight: 1, distance: 0.5, confidence: 0, lastSeen: 0, source: 'none', fps: 0, motion: 0 };
const clamp = (value: number, min = -1, max = 1) => Math.max(min, Math.min(max, value));
const smooth = (from: number, to: number, amount: number) => from + (to - from) * amount;

export function rotationFromFacialMatrix(data?:ArrayLike<number>):{yaw:number;pitch:number;roll:number}|undefined{
  if(!data||data.length!==16||![data[1],data[5],data[8],data[9],data[10]].every(Number.isFinite))return undefined;
  return{yaw:clamp(Math.atan2(data[8],data[10])/.52),pitch:clamp(Math.atan2(-data[9],Math.hypot(data[8],data[10]))/.42),roll:clamp(Math.atan2(data[1],data[5])/.42)};
}

export function useFaceTracking() {
  const [enabled, setEnabled] = useState(true);
  const [restartToken, setRestartToken] = useState(0);
  const [status, setStatus] = useState<TrackingStatus>('off');
  const [pose, setPose] = useState<TrackingPose>(neutralPose);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef(0);
  const poseRef = useRef(neutralPose);
  const lastFrameRef = useRef(0);
  const lastPoseFrameRef = useRef(0);
  const performanceRef = useRef({ started: performance.now(), frames: 0, fps: 0 });

  const retry = useCallback(() => {
    if (!enabled) setEnabled(true);
    else setRestartToken((value) => value + 1);
  }, [enabled]);

  const getVideoElement=useCallback(()=>videoRef.current,[]);
  const getVideoTrack=useCallback(()=>streamRef.current?.getVideoTracks()[0]??null,[]);
  const captureFrame=useCallback(():{dataUrl:string;width:number;height:number;capturedAt:string}|null=>{
    const video=videoRef.current;if(!video?.videoWidth||video.readyState<HTMLMediaElement.HAVE_CURRENT_DATA)return null;
    const width=Math.min(960,video.videoWidth),height=Math.round(video.videoHeight*(width/video.videoWidth)),canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d');if(!context)return null;context.drawImage(video,0,0,width,height);return{dataUrl:canvas.toDataURL('image/jpeg',.84),width,height,capturedAt:new Date().toISOString()};
  },[]);

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    videoRef.current = null;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
    poseLandmarkerRef.current?.close();
    poseLandmarkerRef.current = null;
    poseRef.current = neutralPose;
    setPose(neutralPose);
    setStatus('off');
  }, []);

  useEffect(() => () => stop(), [stop]);

  useEffect(() => {
    if (!enabled) { stop(); return; }
    let cancelled = false;
    let restartTimer = 0;

    const start = async () => {
      setStatus('starting');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // No focusMode requested here on purpose: Chromium rejects the
          // whole getUserMedia call on cameras that don't support it, so it
          // has to be applied afterward as a soft constraint (below), where a
          // camera that doesn't support it just no-ops instead of failing.
          video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
        streamRef.current = stream;
        const cameraTrack = stream.getVideoTracks()[0];
        // Some webcams default to hunting/re-triggering autofocus rather than
        // locking once a subject is found, which reads as the picture
        // constantly racking in and out. Pin focus (and exposure/white
        // balance, which can trigger alongside it) to continuous mode where
        // the driver exposes that control; silently do nothing where it
        // doesn't, since this is a quality-of-life improvement, not a
        // required capability.
        if (cameraTrack && typeof cameraTrack.getCapabilities === 'function') {
          try {
            const capabilities = cameraTrack.getCapabilities() as MediaTrackCapabilities & { focusMode?: string[]; exposureMode?: string[]; whiteBalanceMode?: string[] };
            const advanced: Record<string, string>[] = [];
            if (capabilities.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' });
            if (capabilities.exposureMode?.includes('continuous')) advanced.push({ exposureMode: 'continuous' });
            if (capabilities.whiteBalanceMode?.includes('continuous')) advanced.push({ whiteBalanceMode: 'continuous' });
            if (advanced.length) void cameraTrack.applyConstraints({ advanced } as MediaTrackConstraints).catch(() => {});
          } catch { /* getCapabilities is not implemented on every platform */ }
        }
        cameraTrack?.addEventListener('ended', () => {
          if (cancelled) return;
          setStatus('lost');
          restartTimer = window.setTimeout(() => setRestartToken((value) => value + 1), 700);
        }, { once: true });
        const video = document.createElement('video');
        video.muted = true; video.playsInline = true; video.srcObject = stream;
        await video.play();
        videoRef.current = video;

        const asset = (relative: string) => new URL(relative, window.location.href).href;
        const vision = await FilesetResolver.forVisionTasks(asset('./mediapipe'));
        const faceOptions = (delegate: 'GPU' | 'CPU') => ({
          baseOptions: { modelAssetPath: asset('./models/face_landmarker.task'), delegate },
          runningMode: 'VIDEO' as const,
          numFaces: 1,
          minFaceDetectionConfidence: 0.48,
          minFacePresenceConfidence: 0.48,
          minTrackingConfidence: 0.45,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        });
        let landmarker: FaceLandmarker;
        try { landmarker = await FaceLandmarker.createFromOptions(vision, faceOptions('GPU')); }
        catch { landmarker = await FaceLandmarker.createFromOptions(vision, faceOptions('CPU')); }
        if (cancelled) { landmarker.close(); return; }
        landmarkerRef.current = landmarker;
        const poseOptions = (delegate: 'GPU' | 'CPU') => ({
          baseOptions: { modelAssetPath: asset('./models/pose_landmarker_lite.task'), delegate }, runningMode: 'VIDEO' as const, numPoses: 1,
          // Room-scale tracking needs to keep a person lock after the face becomes
          // too small for the face mesh. Landmark visibility is validated below.
          minPoseDetectionConfidence: .32, minPosePresenceConfidence: .32, minTrackingConfidence: .32,
        });
        let poseLandmarker: PoseLandmarker;
        try { poseLandmarker = await PoseLandmarker.createFromOptions(vision, poseOptions('GPU')); }
        catch { poseLandmarker = await PoseLandmarker.createFromOptions(vision, poseOptions('CPU')); }
        if (cancelled) { poseLandmarker.close(); return; }
        poseLandmarkerRef.current = poseLandmarker;
        setStatus('searching');

        const detect = (now: number) => {
          if (cancelled || !videoRef.current || !landmarkerRef.current) return;
          if (now - lastFrameRef.current >= 45 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            lastFrameRef.current = now;
            const perf=performanceRef.current;
            perf.frames+=1;
            if(now-perf.started>=1000){perf.fps=Math.round(perf.frames*1000/(now-perf.started));perf.frames=0;perf.started=now;}
            let result;
            try { result = landmarker.detectForVideo(video, now); }
            catch {
              setStatus('error');
              rafRef.current = requestAnimationFrame(detect);
              return;
            }
            const face = result.faceLandmarks[0];
            if (face?.length) {
              const leftEye = face[33], rightEye = face[263], nose = face[1], chin = face[152], forehead = face[10];
              const eyeMidX = (leftEye.x + rightEye.x) / 2;
              const eyeMidY = (leftEye.y + rightEye.y) / 2;
              const eyeSpan = Math.max(0.04, Math.abs(rightEye.x - leftEye.x));
              const faceHeight = Math.max(0.08, Math.abs(chin.y - forehead.y));
              const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
              const leftIris = face[468], rightIris = face[473];
              const leftOuter = face[33], leftInner = face[133], rightInner = face[362], rightOuter = face[263];
              const leftTop = face[159], leftBottom = face[145], rightTop = face[386], rightBottom = face[374];
              const eyeRatio = (value: number, start: number, end: number) => clamp(((value - start) / Math.max(0.0001, end - start) - .5) * 2);
              const irisGazeX = leftIris && rightIris ? (eyeRatio(leftIris.x, leftOuter.x, leftInner.x) + eyeRatio(rightIris.x, rightInner.x, rightOuter.x)) / 2 : 0;
              const irisGazeY = leftIris && rightIris ? (eyeRatio(leftIris.y, leftTop.y, leftBottom.y) + eyeRatio(rightIris.y, rightTop.y, rightBottom.y)) / 2 : 0;
              const categories = result.faceBlendshapes[0]?.categories ?? [];
              const shape = (name: string) => categories.find((category) => category.categoryName === name)?.score ?? 0;
              const matrixRotation=rotationFromFacialMatrix(result.facialTransformationMatrixes?.[0]?.data);
              const matrixYaw=matrixRotation?.yaw??0,matrixPitch=matrixRotation?.pitch??0,matrixRoll=matrixRotation?.roll??clamp(roll/.42);
              const target = {
                x: clamp((nose.x - 0.5) * -2.25),
                y: clamp((nose.y - 0.48) * 2.1),
                yaw: clamp(matrixYaw*.72+(nose.x-eyeMidX)/eyeSpan*1.25),
                pitch: clamp(matrixPitch*.68+((nose.y-eyeMidY)/faceHeight*3.2-.45)*.32),
                roll: matrixRoll,
                gazeX: clamp(irisGazeX), gazeY: clamp(irisGazeY),
                blinkLeft: clamp(1 - shape('eyeBlinkLeft'), 0, 1), blinkRight: clamp(1 - shape('eyeBlinkRight'), 0, 1),
                distance: clamp((eyeSpan - 0.11) * 4.2, 0, 1),
              };
              const prior = poseRef.current;
              const motion=clamp(Math.hypot(target.x-prior.x,target.y-prior.y,(target.yaw-prior.yaw)*.5,(target.pitch-prior.pitch)*.35)*2.4,0,1);
              const next: TrackingPose = {
                x: smooth(prior.x, target.x, 0.19), y: smooth(prior.y, target.y, 0.19),
                yaw: smooth(prior.yaw, target.yaw, 0.16), pitch: smooth(prior.pitch, target.pitch, 0.16),
                roll: smooth(prior.roll, target.roll, 0.18), gazeX: smooth(prior.gazeX, target.gazeX, 0.24), gazeY: smooth(prior.gazeY, target.gazeY, 0.24),
                blinkLeft: target.blinkLeft, blinkRight: target.blinkRight,
                distance: smooth(prior.distance, target.distance, 0.12), confidence: smooth(prior.confidence, 1, 0.25), lastSeen: now, source: 'face', fps:perf.fps, motion:smooth(prior.motion,motion,.22),
                // Generous top padding for hair/forehead, since the face mesh
                // starts at the brow, not the hairline.
                box: boundingBox(face, 0.18, 0.65, 0.2),
              };
              poseRef.current = next; setPose(next); setStatus('locked');
            } else {
              if (poseLandmarkerRef.current && now - lastPoseFrameRef.current >= 70) {
                lastPoseFrameRef.current = now;
                const body = (() => { try { return poseLandmarkerRef.current!.detectForVideo(video, now).landmarks[0]; } catch { return undefined; } })();
                if (body?.length) {
                  const nose=body[0],leftShoulder=body[11],rightShoulder=body[12];
                  const visibility=((nose.visibility??0)+(leftShoulder.visibility??0)+(rightShoulder.visibility??0))/3;
                  if(visibility>.22){
                    const shoulderMidX=(leftShoulder.x+rightShoulder.x)/2,shoulderMidY=(leftShoulder.y+rightShoulder.y)/2,span=Math.max(.05,Math.abs(rightShoulder.x-leftShoulder.x)),prior=poseRef.current;
                    const targetX=clamp((nose.x-.5)*-2.2),targetY=clamp((nose.y-.42)*2);const motion=clamp(Math.hypot(targetX-prior.x,targetY-prior.y)*2.1,0,1);
                    const next:TrackingPose={x:smooth(prior.x,targetX,.14),y:smooth(prior.y,targetY,.14),yaw:smooth(prior.yaw,clamp((nose.x-shoulderMidX)/span),.12),pitch:smooth(prior.pitch,clamp((nose.y-shoulderMidY)/.35+.7),.12),roll:smooth(prior.roll,clamp((rightShoulder.y-leftShoulder.y)/span),.12),gazeX:smooth(prior.gazeX,0,.06),gazeY:smooth(prior.gazeY,0,.06),blinkLeft:1,blinkRight:1,distance:smooth(prior.distance,clamp((span-.16)*3.2,0,1),.1),confidence:smooth(prior.confidence,visibility*.78,.16),lastSeen:now,source:'body',fps:performanceRef.current.fps,motion:smooth(prior.motion,motion,.18),box:boundingBox(body,0.14,0.08,0.03)};
                    poseRef.current=next;setPose(next);setStatus('locked');rafRef.current=requestAnimationFrame(detect);return;
                  }
                }
              }
              const elapsed = now - poseRef.current.lastSeen;
              // Detectors may miss individual frames. Preserve a recent lock
              // instead of flashing LOST between pose inferences.
              setStatus(poseRef.current.lastSeen && elapsed < 900 ? 'locked' : poseRef.current.lastSeen && elapsed < 2600 ? 'lost' : 'searching');
              if (elapsed > 2600) {
                const prior = poseRef.current;
                const next = { ...prior, x: smooth(prior.x, 0, .025), y: smooth(prior.y, 0, .025), yaw: smooth(prior.yaw, 0, .025), pitch: smooth(prior.pitch, 0, .025), roll: smooth(prior.roll, 0, .025), gazeX: smooth(prior.gazeX, 0, .03), gazeY: smooth(prior.gazeY, 0, .03), blinkLeft: 1, blinkRight: 1, confidence: smooth(prior.confidence, 0, .04), motion:smooth(prior.motion,0,.05), source: 'none' as const, box: undefined };
                poseRef.current = next; setPose(next);
              }
            }
          }
          rafRef.current = requestAnimationFrame(detect);
        };
        rafRef.current = requestAnimationFrame(detect);
      } catch (reason) {
        const name = reason instanceof DOMException ? reason.name : '';
        setStatus(name === 'NotAllowedError' || name === 'PermissionDeniedError' ? 'denied' : name === 'NotReadableError' ? 'busy' : 'error');
      }
    };
    void start();
    return () => {
      cancelled = true;
      window.clearTimeout(restartTimer);
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      videoRef.current = null;
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
      poseLandmarkerRef.current?.close();
      poseLandmarkerRef.current = null;
    };
  }, [enabled, restartToken, stop]);

  return { enabled, setEnabled, retry, status, pose, getVideoElement, getVideoTrack, captureFrame };
}
