/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Activity,
  Cpu,
  BookOpen,
  Volume2,
  VolumeX,
  Play,
  Pause,
  RotateCcw,
  Video,
  AlertTriangle,
  Award,
  RefreshCw,
  HelpCircle,
  Film,
  Settings,
} from 'lucide-react';

import { AnalysisFrame, Violation, ObservedTube, PhlebotomyEvent, CapColor } from './types';
import { ProtocolEngine, getFriendlyName } from './lib/protocolEngine';
import { getMockDetectionAtTime } from './lib/replayData';

// Subcomponents
import OrderOfDrawRail from './components/OrderOfDrawRail';
import ProtocolDrawer from './components/ProtocolDrawer';
import ScorecardModal from './components/ScorecardModal';
import ViolationOverlay from './components/ViolationOverlay';
import VisionInspector from './components/VisionInspector';

export default function App() {
  const [activeTab, setActiveTab] = useState<'observation' | 'inspector'>('observation');
  const [isProtocolOpen, setIsProtocolOpen] = useState(false);
  const [isScorecardOpen, setIsScorecardOpen] = useState(false);

  // Video State
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Engine & Scoring State
  const engineRef = useRef(new ProtocolEngine());
  const [engineState, setEngineState] = useState({
    lastAcceptedRank: 0,
    observedTubes: [] as ObservedTube[],
    violations: [] as Violation[],
    tourniquetOnTime: null as number | null,
    tourniquetViolationRaised: false,
  });

  // Controls State
  const [isReplayMode, setIsReplayMode] = useState(true); // Default to Replay Mode so user can immediately test with synthetic data
  const [isSpokenMuted, setIsSpokenMuted] = useState(false);
  const [activeViolation, setActiveViolation] = useState<Violation | null>(null);
  const [scorecardStats, setScorecardStats] = useState<any | null>(null);
  const [customApiKey, setCustomApiKey] = useState<string>(() => {
    return localStorage.getItem('FLOWVERIFY_CUSTOM_API_KEY') || '';
  });
  const [demoVideoUrl, setDemoVideoUrl] = useState<string>(() => {
    return localStorage.getItem('FLOWVERIFY_DEMO_VIDEO_URL') || 'https://storage.googleapis.com/flowverify-demo-assets/IloveMP4%20Custom%20Video.mp4';
  });
  const [showDemoSettings, setShowDemoSettings] = useState(false);

  // Gemini Backend Health
  const [apiHealth, setApiHealth] = useState({
    loaded: false,
    isConfigured: false,
    model: 'gemini-3.5-flash',
    message: 'Checking connection...',
  });

  // History & Diagnostics Telemetry
  const [analysisHistory, setAnalysisHistory] = useState<AnalysisFrame[]>([]);
  const [lastSampleTime, setLastSampleTime] = useState<number>(-1);
  const [analysisError, setAnalysisError] = useState<{ message: string; code?: number } | null>(null);

  // Frame lock
  const isAnalyzingRef = useRef(false);
  const prevFrameImageRef = useRef<string | null>(null);

  // Element Refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 1. Fetch Backend API Health
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((data) => {
        setApiHealth({
          loaded: true,
          isConfigured: data.isConfigured,
          model: data.model,
          message: data.message,
        });
        const hasCustomKey = !!localStorage.getItem('FLOWVERIFY_CUSTOM_API_KEY');
        if (data.isConfigured || hasCustomKey) {
          setIsReplayMode(false); // Default to Live AI if any key is configured
        }
      })
      .catch((e) => {
        setApiHealth({
          loaded: true,
          isConfigured: false,
          model: 'gemini-3.5-flash',
          message: 'Unable to connect to FlowVerify backend service.',
        });
        const hasCustomKey = !!localStorage.getItem('FLOWVERIFY_CUSTOM_API_KEY');
        if (hasCustomKey) {
          setIsReplayMode(false);
        }
      });
  }, []);

  // 2. Cleanup Object URLs
  useEffect(() => {
    return () => {
      if (videoUrl && videoUrl.startsWith('blob:')) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);

  // 3. Web Speech API synthesis
  const speakConsequence = (text: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95; // professional, composed voice speed
    window.speechSynthesis.speak(utterance);
  };

  // 4. File handlers
  const handleFile = (file: File) => {
    if (!file) return;
    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
    }
    const url = URL.createObjectURL(file);
    setVideoUrl(url);

    // Reset Analysis & Engine
    engineRef.current.reset();
    setEngineState({
      lastAcceptedRank: 0,
      observedTubes: [],
      violations: [],
      tourniquetOnTime: null,
      tourniquetViolationRaised: false,
    });
    setLastSampleTime(-1);
    setActiveViolation(null);
    setAnalysisHistory([]);
    prevFrameImageRef.current = null;
    isAnalyzingRef.current = false;
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  };

  // 5. Video analysis frame processor
  const processAnalysisFrame = async (currentTime: number) => {
    if (isAnalyzingRef.current) return; // Request lock to prevent overlaps
    isAnalyzingRef.current = true;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) {
      isAnalyzingRef.current = false;
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      isAnalyzingRef.current = false;
      return;
    }

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w === 0 || h === 0) {
      isAnalyzingRef.current = false;
      return;
    }

    // Set canvas dimension with max-width scaling preserving aspect ratio
    let targetWidth = w;
    let targetHeight = h;
    const maxWidth = 1280;
    if (w > maxWidth) {
      const scale = maxWidth / w;
      targetWidth = maxWidth;
      targetHeight = h * scale;
    }

    canvas.width = targetWidth;
    canvas.height = targetHeight;
    ctx.drawImage(video, 0, 0, targetWidth, targetHeight);

    // Encode to JPEG at 0.78 quality
    const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.78);
    const prevFrame = prevFrameImageRef.current;
    prevFrameImageRef.current = jpegDataUrl;

    let rawDetection: any;

    try {
      if (isReplayMode) {
        // Cached Replay Mode
        rawDetection = getMockDetectionAtTime(currentTime);
      } else {
        // Live AI Mode: POST to server
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (customApiKey.trim()) {
          headers['X-API-Key'] = customApiKey.trim();
        }

        const res = await fetch('/api/detect', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            frame: jpegDataUrl,
            previousFrame: prevFrame,
            timestamp: currentTime,
            previousTimestamp: lastSampleTime !== -1 ? lastSampleTime : null,
            width: targetWidth,
            height: targetHeight,
          }),
        });

        if (!res.ok) {
          let errorData;
          try {
            errorData = await res.json();
          } catch (e) {
            // ignore
          }
          const customError = new Error(errorData?.error || `Inference request failed with code: ${res.status}`);
          (customError as any).status = res.status;
          (customError as any).details = errorData?.details;
          throw customError;
        }
        rawDetection = await res.json();
      }

      setAnalysisError(null); // Clear any active analysis error on success

      // Feed frame results to protocol engine
      const { acceptedEvent, tourniquetTime } = engineRef.current.processFrame(
        rawDetection,
        currentTime
      );

      const nextViolations = [...engineRef.current.violations];

      // Update engine states
      setEngineState({
        lastAcceptedRank: engineRef.current.lastAcceptedRank,
        observedTubes: [...engineRef.current.observedTubes],
        violations: nextViolations,
        tourniquetOnTime: engineRef.current.tourniquetOnTime,
        tourniquetViolationRaised: engineRef.current.tourniquetViolationRaised,
      });

      // Spoken warnings on new violations
      if (nextViolations.length > engineState.violations.length) {
        const newlyAdded = nextViolations[nextViolations.length - 1];
        if (!isSpokenMuted) {
          speakConsequence(newlyAdded.consequence);
        }
        setActiveViolation(newlyAdded);
      }

      // Add to diagnostics filmstrip
      const telemetryObj: AnalysisFrame = {
        timestamp: currentTime,
        image: jpegDataUrl,
        rawDetection,
        debouncedEvent: acceptedEvent
          ? { event: acceptedEvent.event, cap_color: acceptedEvent.cap_color }
          : undefined,
        accepted: !!acceptedEvent,
      };

      setAnalysisHistory((prev) => [...prev, telemetryObj]);
    } catch (err: any) {
      console.error('Frame extraction analysis failure:', err);
      setAnalysisError({
        message: err.message || 'Frame extraction analysis failure.',
        code: err.status,
      });
      if (videoRef.current) {
        videoRef.current.pause();
      }
    } finally {
      isAnalyzingRef.current = false;
    }
  };

  // 6. Handle Video Time updates (sample at 1 second intervals)
  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;

    const currentTime = video.currentTime;

    // Reset engine if user seeks backward
    if (currentTime < lastSampleTime) {
      console.info('Seeked backward. Resetting protocol engine context.');
      engineRef.current.reset();
      setEngineState({
        lastAcceptedRank: 0,
        observedTubes: [],
        violations: [],
        tourniquetOnTime: null,
        tourniquetViolationRaised: false,
      });
      setLastSampleTime(currentTime);
      prevFrameImageRef.current = null;
      setActiveViolation(null);
      return;
    }

    // Trigger analysis at roughly 1 second boundary
    const currentSec = Math.floor(currentTime);
    const lastSec = Math.floor(lastSampleTime);

    if (currentSec > lastSec || lastSampleTime === -1) {
      setLastSampleTime(currentTime);
      processAnalysisFrame(currentTime);
    }
  };

  const handleVideoEnded = () => {
    const finalStats = engineRef.current.getScorecard(videoRef.current?.currentTime || 0);
    setScorecardStats(finalStats);
    setIsScorecardOpen(true);
  };

  const handleEndAndScore = () => {
    const finalStats = engineRef.current.getScorecard(videoRef.current?.currentTime || 0);
    setScorecardStats(finalStats);
    setIsScorecardOpen(true);
    videoRef.current?.pause();
  };

  const handleRestart = () => {
    setIsScorecardOpen(false);
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {});
    }
    engineRef.current.reset();
    setEngineState({
      lastAcceptedRank: 0,
      observedTubes: [],
      violations: [],
      tourniquetOnTime: null,
      tourniquetViolationRaised: false,
    });
    setLastSampleTime(-1);
    setActiveViolation(null);
    setAnalysisHistory([]);
    prevFrameImageRef.current = null;
  };

  // Active tube/event status text
  const lastHistory = analysisHistory[analysisHistory.length - 1];
  const activeEventName = lastHistory?.rawDetection?.event || 'none';
  const activeCapColor = lastHistory?.rawDetection?.cap_color || 'none';
  const activeConfidence = lastHistory?.rawDetection?.confidence ?? 0;

  // Compute live tourniquet timer
  const elapsedTourniquetSec =
    engineState.tourniquetOnTime !== null && videoRef.current
      ? videoRef.current.currentTime - engineState.tourniquetOnTime
      : null;

  return (
    <div className="min-h-screen bg-[#0A0A0B] text-[#E2E2E2] flex flex-col font-sans selection:bg-[#0891B2]/20 selection:text-cyan-300">
      {/* 1. TOP BAR BRANDING & CONFIGS */}
      <header className="px-6 py-4 bg-[#121214] border-b border-[#2D2D2D] flex flex-wrap items-center justify-between gap-4 select-none z-30">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-[#0891B2] rounded flex items-center justify-center shadow-[0_0_15px_rgba(8,145,178,0.2)]">
              <Activity className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="text-sm font-bold tracking-widest text-[#E2E2E2] uppercase">FlowVerify</h1>
                <span className="text-[9px] bg-[#2D2D2D] text-[#8E9299] px-1.5 py-0.5 rounded font-mono font-medium">
                  v1.1
                </span>
              </div>
            </div>
          </div>
          <div className="hidden md:block h-6 w-px bg-[#2D2D2D]"></div>
          <div className="hidden lg:flex flex-col">
            <span className="text-[9px] text-[#8E9299] uppercase tracking-wider font-semibold">Active Protocol</span>
            <span className="text-xs font-medium text-[#E2E2E2]">WHO Phlebotomy Order of Draw (2010)</span>
          </div>
        </div>

        {/* Right side controls */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Gemini connection state badge */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#1A1B1E] border border-[#2D2D2D] text-[11px] font-mono">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                apiHealth.isConfigured || customApiKey.trim() ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
              }`}
            />
            <span className="text-[#8E9299]" title={apiHealth.message}>
              {apiHealth.isConfigured
                ? `${apiHealth.model} (Inference API)`
                : customApiKey.trim()
                ? 'Custom Key Active'
                : 'Replay Mode Active'}
            </span>
          </div>

          {/* Persistent View Inspector and Observation toggles */}
          <div className="flex items-center p-1 bg-[#1A1B1E] border border-[#2D2D2D] rounded">
            <button
              onClick={() => setActiveTab('observation')}
              className={`px-3 py-1 text-xs font-semibold rounded uppercase tracking-wider transition-all ${
                activeTab === 'observation'
                  ? 'bg-[#0891B2]/10 text-[#06B6D4] border border-[#0891B2]/30 font-bold'
                  : 'text-[#8E9299] hover:text-[#E2E2E2]'
              }`}
            >
              Observation Lab
            </button>
            <button
              onClick={() => setActiveTab('inspector')}
              className={`px-3 py-1 text-xs font-semibold rounded uppercase tracking-wider transition-all flex items-center gap-1.5 ${
                activeTab === 'inspector'
                  ? 'bg-[#0891B2]/10 text-[#06B6D4] border border-[#0891B2]/30 font-bold'
                  : 'text-[#8E9299] hover:text-[#E2E2E2]'
              }`}
            >
              <Cpu className="w-3.5 h-3.5" />
              Vision Inspector
            </button>
          </div>

          {/* View Protocol Button */}
          <button
            onClick={() => setIsProtocolOpen(true)}
            className="px-3 py-1.5 bg-[#2D2D2D] border border-[#3D3D3D] hover:bg-[#3D3D3D] rounded text-xs font-semibold text-[#E2E2E2] uppercase tracking-widest transition-colors flex items-center gap-1.5"
          >
            <BookOpen className="w-3.5 h-3.5 text-[#06B6D4]" />
            View Protocol Spec
          </button>
        </div>
      </header>

      {/* 2. MAIN CORE LAYOUT CONTAINER */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 flex flex-col gap-6 overflow-hidden">
        {/* Connection state banner warning if Gemini is not configured */}
        {!apiHealth.isConfigured && apiHealth.loaded && (
          <div className="p-4 bg-[#1A1B1E] border border-[#2D2D2D] rounded flex flex-col md:flex-row md:items-center justify-between gap-4 text-xs animate-fade-in select-none">
            <div className="flex items-start gap-2.5 flex-1">
              <AlertTriangle className="w-5 h-5 flex-shrink-0 text-[#D97706] mt-0.5" />
              <div className="space-y-1">
                <p className="text-[#E2E2E2] font-semibold text-sm">
                  Gemini API Quota Check / Set Custom API Key
                </p>
                <p className="text-[#8E9299]">
                  FlowVerify requires a high-quota Gemini key. If you are experiencing <span className="text-amber-400 font-semibold">429 (Resource Exhausted)</span> errors, you can paste your own personal API key here to bypass the rate limits. Keys are stored safely in your local browser session.
                </p>
                <div className="pt-2 flex flex-wrap items-center gap-2">
                  <input
                    type="password"
                    placeholder="Paste Gemini API Key (AIzaSy...)"
                    value={customApiKey}
                    onChange={(e) => {
                      const val = e.target.value;
                      setCustomApiKey(val);
                      localStorage.setItem('FLOWVERIFY_CUSTOM_API_KEY', val);
                    }}
                    className="px-3 py-1.5 bg-[#121214] border border-[#2D2D2D] rounded text-xs text-[#E2E2E2] placeholder-[#8E9299] focus:outline-none focus:border-[#0891B2] w-64 md:w-80 font-mono transition-colors"
                  />
                  {customApiKey.trim() && (
                    <button
                      onClick={() => {
                        setCustomApiKey('');
                        localStorage.removeItem('FLOWVERIFY_CUSTOM_API_KEY');
                      }}
                      className="text-[10px] text-[#DC2626] hover:underline font-semibold font-mono bg-red-950/10 border border-red-900/20 px-2 py-1 rounded transition-all"
                    >
                      Clear Key
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setIsReplayMode(false);
                  handleRestart();
                }}
                className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded transition-colors ${
                  !isReplayMode
                    ? 'bg-[#0891B2] text-white hover:bg-[#06B6D4]'
                    : 'bg-[#2D2D2D] text-[#8E9299] hover:text-[#E2E2E2] border border-[#3D3D3D]'
                }`}
              >
                Live AI Mode
              </button>
              <button
                onClick={() => {
                  setIsReplayMode(true);
                  handleRestart();
                }}
                className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded transition-colors ${
                  isReplayMode
                    ? 'bg-[#0891B2] text-white hover:bg-[#06B6D4]'
                    : 'bg-[#2D2D2D] text-[#8E9299] hover:text-[#E2E2E2] border border-[#3D3D3D]'
                }`}
              >
                Replay Mode
              </button>
            </div>
          </div>
        )}

        {/* Hidden Canvas used for video frame drawing */}
        <canvas ref={canvasRef} className="hidden" />

        {/* Persistent View layout (keeps both views in DOM to continue background scanning) */}
        <div className="flex-1 grid grid-cols-1 gap-6 min-h-[500px]">
          {/* TAB 1: OBSERVATION PAGE */}
          <div className={`${activeTab === 'observation' ? 'grid grid-cols-1 lg:grid-cols-3 gap-6' : 'hidden'}`}>
            {/* Left/Center: Video workspace */}
            <div className="lg:col-span-2 flex flex-col space-y-4">
              {analysisError && (
                <div className="p-4 bg-[#DC2626]/10 border border-[#DC2626]/30 text-[#E2E2E2] rounded flex flex-col gap-3 animate-fade-in select-none">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="w-5 h-5 text-[#DC2626] flex-shrink-0 mt-0.5" />
                    <div>
                      <h4 className="font-bold text-sm uppercase tracking-wide text-red-400">
                        {analysisError.code === 429
                          ? 'Gemini API Rate Limit / Quota Exceeded (429)'
                          : 'Inference Execution Failed'}
                      </h4>
                      <p className="text-xs text-[#8E9299] mt-1 leading-relaxed">
                        {analysisError.message}
                      </p>
                      {analysisError.code === 429 && (
                        <p className="text-xs text-[#06B6D4] mt-2 font-medium">
                          💡 Tip: Paste your own personal Gemini API Key in the settings panel above to bypass this global rate limit.
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setAnalysisError(null)}
                      className="px-3 py-1 bg-[#2D2D2D] hover:bg-[#3D3D3D] text-[10px] font-bold uppercase tracking-wider rounded font-mono text-[#8E9299] hover:text-[#E2E2E2] transition-colors"
                    >
                      Dismiss Error
                    </button>
                    {analysisError.code === 429 && (
                      <button
                        onClick={() => {
                          setIsReplayMode(true);
                          setAnalysisError(null);
                          handleRestart();
                        }}
                        className="px-3 py-1 bg-[#0891B2]/10 hover:bg-[#0891B2]/20 text-[#06B6D4] border border-[#0891B2]/30 text-[10px] font-bold uppercase tracking-wider rounded transition-all"
                      >
                        Switch to Replay Mode
                      </button>
                    )}
                  </div>
                </div>
              )}
              {/* Dropzone or Video player */}
              {!videoUrl ? (
                <div
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`flex-1 min-h-[400px] border-2 border-dashed rounded flex flex-col items-center justify-center p-8 text-center cursor-pointer select-none transition-all ${
                    dragOver
                      ? 'border-[#0891B2] bg-[#0891B2]/5 text-[#06B6D4]'
                      : 'border-[#2D2D2D] bg-[#121214] hover:border-[#3D3D3D] hover:bg-[#1A1B1E]'
                  }`}
                >
                  <input
                    type="file"
                    ref={fileInputRef}
                    accept="video/mp4,video/webm,video/quicktime"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) {
                        handleFile(e.target.files[0]);
                      }
                    }}
                  />
                  <div className="p-4 bg-[#1A1B1E] border border-[#2D2D2D] rounded mb-4 text-[#06B6D4] shadow-xl">
                    <Video className="w-8 h-8" />
                  </div>
                  <h3 className="text-sm font-semibold text-[#E2E2E2] uppercase tracking-wider">
                    Upload Clinical Phlebotomy Video
                  </h3>
                  <p className="text-xs text-[#8E9299] max-w-sm mt-2 leading-relaxed">
                    Drag and drop your MP4, MOV, or WebM recording here, or click to choose from directory. Files are parsed locally on the client canvas.
                  </p>
                  
                  {/* Default / Demo video option */}
                  <div className="mt-5 flex flex-col sm:flex-row items-center gap-3" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="px-4 py-2 bg-[#1A1B1E] hover:bg-[#2D2D2D] text-[#E2E2E2] hover:text-white text-xs font-bold uppercase tracking-wider rounded border border-[#2D2D2D] hover:border-[#3D3D3D] transition-colors"
                    >
                      Browse Local Files
                    </button>
                    <span className="text-[10px] text-[#8E9299] font-bold uppercase tracking-wider">or</span>
                    <button
                      type="button"
                      onClick={() => {
                        setVideoUrl(demoVideoUrl);
                        // Reset everything
                        engineRef.current.reset();
                        setEngineState({
                          lastAcceptedRank: 0,
                          observedTubes: [],
                          violations: [],
                          tourniquetOnTime: null,
                          tourniquetViolationRaised: false,
                        });
                        setLastSampleTime(-1);
                        setActiveViolation(null);
                        setAnalysisHistory([]);
                        prevFrameImageRef.current = null;
                        isAnalyzingRef.current = false;
                      }}
                      className="px-4 py-2 bg-[#0891B2] hover:bg-[#06B6D4] text-white text-xs font-bold uppercase tracking-wider rounded transition-colors shadow-lg shadow-[#0891B2]/10 flex items-center gap-1.5"
                    >
                      <Film className="w-3.5 h-3.5" />
                      Try Built-In Demo Video
                    </button>
                  </div>

                  {/* Custom cloud storage demo configuration tool */}
                  <div className="mt-4 w-full max-w-md bg-[#161719] border border-[#2D2D2D] rounded-lg p-3 text-left" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => setShowDemoSettings(!showDemoSettings)}
                      className="w-full flex items-center justify-between text-[#8E9299] hover:text-[#E2E2E2] text-xs font-semibold uppercase tracking-wider transition-colors"
                    >
                      <span className="flex items-center gap-1.5">
                        <Settings className="w-3.5 h-3.5 text-[#06B6D4]" />
                        Cloud Storage Demo Config
                      </span>
                      <span className="text-[10px] text-[#06B6D4] hover:underline">
                        {showDemoSettings ? 'Hide Settings' : 'Configure GCS Video'}
                      </span>
                    </button>

                    {showDemoSettings && (
                      <div className="mt-3 border-t border-[#2D2D2D] pt-3 flex flex-col gap-3 animate-fade-in">
                        <div>
                          <label className="block text-[10px] font-bold text-[#E2E2E2] uppercase tracking-wide mb-1">
                            Demo Video Public HTTPS Link
                          </label>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={demoVideoUrl}
                              onChange={(e) => setDemoVideoUrl(e.target.value)}
                              placeholder="e.g. https://storage.googleapis.com/my-bucket/video.mp4"
                              className="flex-1 px-2 py-1.5 text-xs bg-[#1A1B1E] border border-[#2D2D2D] rounded text-white font-mono focus:outline-none focus:border-[#0891B2]"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                localStorage.setItem('FLOWVERIFY_DEMO_VIDEO_URL', demoVideoUrl);
                                alert('Demo video URL saved successfully!');
                              }}
                              className="px-3 py-1.5 bg-[#0891B2]/15 hover:bg-[#0891B2]/25 border border-[#0891B2]/30 text-[#06B6D4] text-xs font-bold uppercase tracking-wider rounded transition-colors"
                            >
                              Save
                            </button>
                          </div>
                        </div>

                        <div className="p-2 bg-[#1A1B1E]/60 rounded border border-[#2D2D2D] text-[11px] leading-relaxed text-[#8E9299] space-y-2">
                          <p className="font-bold text-[#E2E2E2] uppercase tracking-wider text-[10px]">
                            💡 Google Cloud Storage Public & CORS Access:
                          </p>
                          <ol className="list-decimal pl-4 space-y-1.5">
                            <li>
                              <strong>Permissions:</strong> Uniform Bucket-Level Access (UBLA) disables object ACLs. Grant the <strong>Storage Object Viewer</strong> (<code className="bg-[#2D2D2D] text-[#E2E2E2] px-1 rounded">roles/storage.objectViewer</code>) role to <code className="bg-[#2D2D2D] text-[#E2E2E2] px-1 rounded">allUsers</code> on the bucket to make files public.
                            </li>
                            <li>
                              <strong>HTTPS URL:</strong> Use the public URL format: <br />
                              <code className="text-[#06B6D4] select-all bg-[#1A1B1E] px-1 rounded block mt-0.5 font-mono break-all">
                                https://storage.googleapis.com/YOUR_BUCKET_NAME/YOUR_VIDEO_NAME.mp4
                              </code>
                            </li>
                            <li>
                              <strong>CORS Config:</strong> Ensure GCS has CORS enabled so client browser canvas can analyze frames. Save this JSON as <code className="text-white">cors.json</code>:
                              <pre className="mt-1 p-1 bg-[#121214] border border-[#2D2D2D] rounded text-[9px] font-mono leading-tight text-[#06B6D4] overflow-x-auto whitespace-pre">
{`[
  {
    "origin": ["*"],
    "method": ["GET", "HEAD", "OPTIONS"],
    "responseHeader": ["Content-Type", "Access-Control-Allow-Origin"],
    "maxAgeSeconds": 3600
  }
]`}
                              </pre>
                              Then run in your Cloud Shell terminal:
                              <code className="block mt-1 p-1 bg-[#121214] border border-[#2D2D2D] rounded text-[9px] font-mono text-[#06B6D4] break-all leading-tight">
                                gcloud storage buckets update gs://YOUR_BUCKET_NAME --cors-file=cors.json
                              </code>
                            </li>
                          </ol>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-5 flex flex-wrap justify-center gap-2">
                    <span className="text-[10px] bg-[#1A1B1E] border border-[#2D2D2D] px-2 py-1 rounded text-[#8E9299] font-mono uppercase tracking-wider">
                      GCS Integrated
                    </span>
                    <span className="text-[10px] bg-[#1A1B1E] border border-[#2D2D2D] px-2 py-1 rounded text-[#8E9299] font-mono uppercase tracking-wider">
                      1 FPS Frame Sampling
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex-1 rounded bg-[#121214] border border-[#2D2D2D] p-4 flex flex-col justify-between relative select-none">
                  {/* Top toolbar */}
                  <div className="flex items-center justify-between border-b border-[#2D2D2D] pb-2.5 mb-3">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-[#06B6D4] font-mono">
                      Phlebotomy Scanner Core View
                    </span>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-[#8E9299] font-mono text-[10px] uppercase">
                        sampling 1 FPS
                      </span>
                      <button
                        onClick={() => handleFile(null as any)}
                        className="text-[10px] text-[#8E9299] hover:text-[#DC2626] underline font-semibold transition-colors uppercase tracking-wider"
                      >
                        Replace Video
                      </button>
                    </div>
                  </div>

                  {/* Frame Scanner bounds */}
                  <div className="relative aspect-video bg-black rounded border border-[#2D2D2D] overflow-hidden group flex-1">
                    <video
                      ref={videoRef}
                      src={videoUrl}
                      className="w-full h-full object-contain"
                      onTimeUpdate={handleTimeUpdate}
                      onEnded={handleVideoEnded}
                      controls={false}
                      crossOrigin="anonymous"
                    />

                    {/* Corner decorators for the instrument feel */}
                    <div className="absolute top-3 left-3 w-4 h-4 border-t-2 border-l-2 border-[#0891B2]/40" />
                    <div className="absolute top-3 right-3 w-4 h-4 border-t-2 border-r-2 border-[#0891B2]/40" />
                    <div className="absolute bottom-3 left-3 w-4 h-4 border-b-2 border-l-2 border-[#0891B2]/40" />
                    <div className="absolute bottom-3 right-3 w-4 h-4 border-b-2 border-r-2 border-[#0891B2]/40" />

                    {/* Violation banner overlays bottom of the video */}
                    <ViolationOverlay
                      violation={activeViolation}
                      onDismiss={() => setActiveViolation(null)}
                      isMuted={isSpokenMuted}
                      onToggleMute={() => setIsSpokenMuted(!isSpokenMuted)}
                    />
                  </div>

                  {/* Transport & Controls Toolbar */}
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-4 bg-[#1A1B1E] p-3 rounded border border-[#2D2D2D]">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          const v = videoRef.current;
                          if (v) {
                            if (v.paused) v.play().catch(() => {});
                            else v.pause();
                          }
                        }}
                        className="p-2 rounded bg-[#0891B2] hover:bg-[#06B6D4] text-white font-bold transition-all shadow-md shadow-cyan-950/20"
                        title="Toggle Play / Pause"
                      >
                        {videoRef.current?.paused ? (
                          <Play className="w-4 h-4" />
                        ) : (
                          <Pause className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => {
                          if (videoRef.current) videoRef.current.currentTime = 0;
                          handleRestart();
                        }}
                        className="p-2 rounded bg-[#2D2D2D] hover:bg-[#3D3D3D] border border-[#3D3D3D] text-[#E2E2E2] transition-all"
                        title="Reset Run"
                      >
                        <RotateCcw className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Active sampling readout chip */}
                    <div className="flex items-center gap-4 text-xs font-mono">
                      <div>
                        <span className="text-[#8E9299] block text-[9px] uppercase tracking-wider font-semibold">Active Tube</span>
                        <span className="text-[#E2E2E2]">
                          {activeCapColor === 'none' ? 'No Tube Detected' : getFriendlyName(activeCapColor)}
                        </span>
                      </div>
                      <div>
                        <span className="text-[#8E9299] block text-[9px] uppercase tracking-wider font-semibold">Confidence</span>
                        <span className="text-[#06B6D4] font-bold">
                          {activeConfidence > 0 ? `${Math.round(activeConfidence * 100)}%` : '--'}
                        </span>
                      </div>
                    </div>

                    {/* Mode Selector & Mute */}
                    <div className="flex items-center gap-3">
                      {/* Active mode */}
                      <div className="flex items-center gap-1.5 p-1 rounded bg-[#121214] border border-[#2D2D2D]">
                        <button
                           onClick={() => {
                             setIsReplayMode(false);
                             handleRestart();
                           }}
                           disabled={!apiHealth.isConfigured && !customApiKey.trim()}
                           className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-all ${
                             !isReplayMode
                               ? 'bg-[#0891B2]/10 text-[#06B6D4] border border-[#0891B2]/30'
                               : 'text-[#8E9299] hover:text-[#E2E2E2] disabled:opacity-40'
                           }`}
                           title={!apiHealth.isConfigured && !customApiKey.trim() ? 'Requires GEMINI_API_KEY' : ''}
                        >
                          Live AI
                        </button>
                        <button
                           onClick={() => {
                             setIsReplayMode(true);
                             handleRestart();
                           }}
                           className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-all ${
                             isReplayMode
                               ? 'bg-[#0891B2]/10 text-[#06B6D4] border border-[#0891B2]/30'
                               : 'text-[#8E9299] hover:text-[#E2E2E2]'
                           }`}
                        >
                          Replay Cached
                        </button>
                      </div>

                      {/* Vocal alert toggle */}
                      <button
                        onClick={() => setIsSpokenMuted(!isSpokenMuted)}
                        className={`p-2 rounded border transition-all ${
                          isSpokenMuted
                            ? 'bg-[#2D2D2D] border-[#3D3D3D] text-[#8E9299]'
                            : 'bg-[#0891B2]/10 border-[#0891B2]/30 text-[#06B6D4]'
                        }`}
                        title={isSpokenMuted ? 'Voice Synthesizer off' : 'Voice Synthesizer on'}
                      >
                        {isSpokenMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Lower Section: Tourniquet & Score triggers */}
              {videoUrl && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 select-none">
                  {/* Tourniquet Timer Card */}
                  <div className="sm:col-span-1 p-4 rounded bg-[#121214] border border-[#2D2D2D] flex items-center justify-between">
                    <div>
                      <span className="text-[10px] text-[#8E9299] uppercase tracking-wider block font-semibold">
                        Tourniquet Timer
                      </span>
                      <span
                        className={`text-2xl font-bold font-mono ${
                          elapsedTourniquetSec === null
                            ? 'text-gray-600'
                            : elapsedTourniquetSec > 60
                            ? 'text-[#DC2626]'
                            : 'text-[#D97706] animate-pulse'
                        }`}
                      >
                        {elapsedTourniquetSec === null ? '00.0s' : `${elapsedTourniquetSec.toFixed(1)}s`}
                      </span>
                    </div>
                    <span
                      className={`text-[10px] px-2 py-1 rounded uppercase font-semibold tracking-wider font-mono ${
                        elapsedTourniquetSec === null
                          ? 'bg-[#2D2D2D] text-[#8E9299] border border-[#3D3D3D]'
                          : 'bg-[#D97706]/10 text-[#D97706] border border-[#D97706]/20'
                      }`}
                    >
                      {elapsedTourniquetSec === null ? 'Released' : 'Occluding'}
                    </span>
                  </div>

                  {/* Exception Counters */}
                  <div className="sm:col-span-1 p-4 rounded bg-[#121214] border border-[#2D2D2D] flex items-center justify-between">
                    <div>
                      <span className="text-[10px] text-[#8E9299] uppercase tracking-wider block font-semibold">
                        Protocol Exceptions
                      </span>
                      <span
                        className={`text-2xl font-bold font-mono ${
                          engineState.violations.length > 0 ? 'text-[#DC2626]' : 'text-emerald-400'
                        }`}
                      >
                        {engineState.violations.length}
                      </span>
                    </div>
                    <span className="text-[10px] bg-[#2D2D2D] border border-[#3D3D3D] text-[#8E9299] px-2 py-1 rounded font-mono uppercase tracking-wider">
                      active run
                    </span>
                  </div>

                  {/* End & Score Card */}
                  <button
                    onClick={handleEndAndScore}
                    className="sm:col-span-1 p-4 bg-[#DC2626]/10 border border-[#DC2626]/50 hover:bg-[#DC2626]/20 text-[#DC2626] rounded font-bold uppercase tracking-widest text-xs transition-all flex items-center justify-center gap-2 group shadow-xl"
                  >
                    <Award className="w-5 h-5 flex-shrink-0" />
                    <span>End & Score Run</span>
                  </button>
                </div>
              )}
            </div>

            {/* Right side: Compliance order rail */}
            <div className="lg:col-span-1">
              <OrderOfDrawRail
                lastAcceptedRank={engineState.lastAcceptedRank}
                observedTubes={engineState.observedTubes}
              />
            </div>
          </div>

          {/* TAB 2: VISION DIAGNOSTIC INSPECTOR */}
          <div className={`${activeTab === 'inspector' ? 'block' : 'hidden'}`}>
            <VisionInspector history={analysisHistory} />
          </div>
        </div>
      </main>

      {/* 3. DRAWERS & MODALS OVERLAYS */}
      <ProtocolDrawer isOpen={isProtocolOpen} onClose={() => setIsProtocolOpen(false)} />

      <ScorecardModal
        isOpen={isScorecardOpen}
        onClose={() => setIsScorecardOpen(false)}
        onRestart={handleRestart}
        stats={scorecardStats}
      />
    </div>
  );
}
