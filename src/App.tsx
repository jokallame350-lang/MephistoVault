import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Upload, Download, Activity, Shield, X, Copy, Check, File as FileIcon, Loader2, MessageSquare, Send, Lock, Sun, Moon, Clock, Smile, Clipboard, QrCode, Globe, Bomb, Wifi, Play, Radio, Users, Folder, Camera, Archive, Eye, Zap, EyeOff, Flame, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence, animate } from 'framer-motion';
import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';
import JSZip from 'jszip';
import { QRCodeSVG } from 'qrcode.react';
import { Html5Qrcode } from 'html5-qrcode';
import { i18n, SUPPORTED_LANGS, type LangKey } from './i18n';

const CHUNK_SIZE = 16 * 1024;
const SELF_DESTRUCT_SEC = 300;

// i18n is now imported from ./i18n.ts

function generateCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let str = '';
  for (let i = 0; i < 6; i++) {
    str += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const pin = Math.floor(1000 + Math.random() * 9000);
  return `${str.substring(0, 3)}-${str.substring(3, 6)}#${pin}`;
}

function AnimatedCounter({ value, className }: { value: number, className?: string }) {
  const nodeRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = nodeRef.current;
    if (node) {
      const controls = animate(parseInt(node.textContent || '0'), value, {
        duration: 0.5,
        onUpdate(v) { node.textContent = Math.round(v).toString() + '%'; }
      });
      return () => controls.stop();
    }
  }, [value]);
  return <span ref={nodeRef} className={className}>{value}%</span>;
}

function formatBytes(bytes: number, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function App() {
  const [mode, setMode] = useState<'idle' | 'send' | 'receive'>('idle');
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('ms-theme') as 'dark' | 'light') || 'dark');

  // PeerJS State
  const peerRef = useRef<Peer | null>(null);
  const connRef = useRef<DataConnection | null>(null);
  const multiConnsRef = useRef<DataConnection[]>([]); // Multi-peer room
  const [peerCount, setPeerCount] = useState(0);

  const [shareCode, setShareCode] = useState<string>('');
  const [receiveCode, setReceiveCode] = useState<string>('');
  const [isConnected, setIsConnected] = useState(false);
  const [errorStatus, setErrorStatus] = useState<string | null>(null);

  const [fileToShare, setFileToShare] = useState<File | null>(null);
  const fileToShareRef = useRef<File | null>(null);
  const [transferProgress, setTransferProgress] = useState(-1);
  const [fileMeta, setFileMeta] = useState<{ name: string, size: number, type: string } | null>(null);
  const fileMetaRef = useRef<{ name: string, size: number, type: string } | null>(null);
  const [isZipping, setIsZipping] = useState(false);
  const [zipProgress, setZipProgress] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  // Chat State
  const [chatMessages, setChatMessages] = useState<{ id: number, text: string, sender: 'me' | 'peer', emoji?: string }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  // Receiver chunks
  const receivedChunksRef = useRef<ArrayBuffer[]>([]);
  const receivedBytesRef = useRef(0);
  const [completedFile, setCompletedFile] = useState<{ blob: Blob, name: string, type: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // NEW: Connection Timer
  const [connTime, setConnTime] = useState(0);
  const connTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // NEW: File Preview
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // NEW: QR Code visibility
  const [showQR, setShowQR] = useState(false);

  // NEW: Self-destruct timer
  const [selfDestructSec, setSelfDestructSec] = useState(0);
  const selfDestructRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // i18n — now supports 5 languages
  const [lang, setLang] = useState<LangKey>(() => {
    const saved = localStorage.getItem('ms-lang') as LangKey;
    if (saved && SUPPORTED_LANGS.some(l => l.code === saved)) return saved;
    const nav = navigator.language.substring(0, 2);
    const match = SUPPORTED_LANGS.find(l => l.code === nav);
    return match ? match.code : 'en';
  });
  const [showLangPicker, setShowLangPicker] = useState(false);
  const t = (key: string) => i18n[lang]?.[key] || i18n['en'][key] || key;
  const [sessionTransfers, setSessionTransfers] = useState(0);

  // Prevent browser from opening files if dropped outside the drop zone
  useEffect(() => {
    const preventDefault = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', preventDefault);
    window.addEventListener('drop', preventDefault);
    return () => {
      window.removeEventListener('dragover', preventDefault);
      window.removeEventListener('drop', preventDefault);
    };
  }, []);

  // Tier 3: Video Preview
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const [showVideoPlayer, setShowVideoPlayer] = useState(false);

  // UX Polish: QR Scanner & UI
  const [showQRScanner, setShowQRScanner] = useState(false);
  const qrRegionRef = useRef<HTMLDivElement>(null);
  const html5QrCodeRef = useRef<Html5Qrcode | null>(null);

  // UX Polish: ZIP Preview
  const [zipContents, setZipContents] = useState<{ name: string, path: string, dir: boolean, size: number }[]>([]);
  const [showZipPreview, setShowZipPreview] = useState(false);

  // Tier 3: LAN Discovery
  const [nearbyDevices, setNearbyDevices] = useState<{ id: string, name: string, time: number, code?: string }[]>([]);
  const [showNearby, setShowNearby] = useState(false);
  const bcRef = useRef<BroadcastChannel | null>(null);

  // Initialize Share Code for Sender — always generate fresh code
  useEffect(() => {
    if (mode === 'send') {
      const newCode = generateCode();
      setShareCode(newCode);
    }
  }, [mode]);

  // Auto-join room from URL param (?room=abc-xyz%231234)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get('room');
    if (roomCode) {
      // Clean URL without reload
      window.history.replaceState({}, '', window.location.pathname);
      setReceiveCode(roomCode);
      setMode('receive');
      // Auto-connect after a short delay
      setTimeout(() => {
        resetConnection();
        setErrorStatus(null);
        setTransferProgress(0);

        const parts = roomCode.trim().toLowerCase().split('#');
        const cleanCode = parts[0].replace('-', '');
        const targetId = `mephisto-${cleanCode}`;

        const peer = new Peer({ debug: 2 });
        peer.on('open', () => {
          const conn = peer.connect(targetId, { reliable: true });
          connRef.current = conn;
          conn.on('open', () => {
            setIsConnected(true);
            const handshakeInterval = setInterval(() => {
              if (fileMetaRef.current || !conn.open) { clearInterval(handshakeInterval); return; }
              conn.send({ type: 'request-metadata' });
            }, 500);
          });
          conn.on('data', (data: any) => {
            try {
              if (data.type === 'metadata' && !fileMetaRef.current) {
                const meta = { name: data.name, size: data.size, type: data.mime };
                setFileMeta(meta); fileMetaRef.current = meta;
                receivedChunksRef.current = []; receivedBytesRef.current = 0;
                setTransferProgress(0);
                conn.send({ type: 'request-chunk', offset: 0 });
              } else if (data.type === 'chunk') {
                const buffer = data.buffer;
                if (!buffer) throw new Error('Empty buffer');
                const scrambled = new Uint8Array(buffer);
                const pinStr = roomCode.split('#')[1] || '0';
                const pin = parseInt(pinStr) || 1024;
                for (let i = 0; i < scrambled.length; i++) { scrambled[i] ^= (pin % 256); }
                receivedChunksRef.current.push(scrambled.buffer);
                receivedBytesRef.current += scrambled.buffer.byteLength;
                const m = fileMetaRef.current;
                if (m) {
                  const progress = Math.round((receivedBytesRef.current / m.size) * 100);
                  if (receivedBytesRef.current < m.size) {
                    setTransferProgress(Math.min(99, progress));
                    conn.send({ type: 'request-chunk', offset: receivedBytesRef.current });
                  } else {
                    setTransferProgress(100);
                    finalizeDownload(m.name, m.type);
                  }
                }
              } else if (data.type === 'chat') {
                setChatMessages(prev => [...prev, { id: Date.now(), text: data.text, sender: 'peer' }]);
              }
            } catch (err: any) { setErrorStatus('Data error: ' + err.message); }
          });
          conn.on('close', () => { setIsConnected(false); });
          conn.on('error', (err) => { setErrorStatus(err.message); });
        });
        peer.on('error', () => { setErrorStatus(t('errorPeer')); setTransferProgress(-1); });
        peerRef.current = peer;
      }, 300);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  // Intentionally run only on mount — auto-join from URL is a one-time action

  // Clean up Peer on unmount or mode change
  useEffect(() => {
    return () => {
      resetConnection();
      setFileToShare(null);
      fileToShareRef.current = null;
    };
  }, [mode]);

  // Auto-scroll chat to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // Theme persistence
  useEffect(() => {
    localStorage.setItem('ms-theme', theme);
    document.documentElement.classList.toggle('light-theme', theme === 'light');
  }, [theme]);

  // Language persistence
  useEffect(() => {
    localStorage.setItem('ms-lang', lang);
  }, [lang]);

  // Self-destruct countdown after transfer completes
  useEffect(() => {
    if (transferProgress >= 100 && isConnected) {
      setSelfDestructSec(SELF_DESTRUCT_SEC);
      selfDestructRef.current = setInterval(() => {
        setSelfDestructSec(prev => {
          if (prev <= 1) {
            resetConnection();
            setMode('idle');
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => { if (selfDestructRef.current) clearInterval(selfDestructRef.current); };
  }, [transferProgress, isConnected]);

  // Connection timer
  useEffect(() => {
    if (isConnected) {
      setConnTime(0);
      connTimerRef.current = setInterval(() => setConnTime(t => t + 1), 1000);
    } else {
      if (connTimerRef.current) clearInterval(connTimerRef.current);
      connTimerRef.current = null;
    }
    return () => { if (connTimerRef.current) clearInterval(connTimerRef.current); };
  }, [isConnected]);

  // File preview URL
  useEffect(() => {
    if (fileToShare && fileToShare.type.startsWith('image/')) {
      const url = URL.createObjectURL(fileToShare);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setPreviewUrl(null);
    }
  }, [fileToShare]);

  // Video preview URL for completed file
  useEffect(() => {
    if (completedFile && completedFile.type.startsWith('video/')) {
      const url = URL.createObjectURL(completedFile.blob);
      setVideoPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setVideoPreviewUrl(null);
      setShowVideoPlayer(false);
    }
  }, [completedFile]);

  // UX Polish: Automatically extract ZIP file info if received
  useEffect(() => {
    if (completedFile && completedFile.name.endsWith('.zip')) {
      const loadZip = async () => {
        try {
          const zip = new JSZip();
          const loadedZip = await zip.loadAsync(completedFile.blob);
          const contents: typeof zipContents = [];

          loadedZip.forEach((relativePath, zipEntry) => {
            // Include both files and interesting dirs
            contents.push({
              name: zipEntry.name.split('/').filter(Boolean).pop() || zipEntry.name,
              path: relativePath,
              dir: zipEntry.dir,
              size: (zipEntry as any)._data?.uncompressedSize || 0
            });
          });

          setZipContents(contents.sort((a, b) => (a.dir === b.dir ? 0 : a.dir ? -1 : 1)));
        } catch (err) {
          console.error('ZIP Parse Error:', err);
        }
      };
      loadZip();
    } else {
      setZipContents([]);
      setShowZipPreview(false);
    }
  }, [completedFile]);

  // UX Polish: QR Scanner toggle logic
  useEffect(() => {
    if (showQRScanner) {
      const html5QrCode = new Html5Qrcode("qr-reader");
      html5QrCodeRef.current = html5QrCode;

      html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          try {
            // Handle if it's our URL format
            const url = new URL(decodedText);
            const code = url.searchParams.get('room');
            setReceiveCode(code || decodedText);
            setShowQRScanner(false);
          } catch {
            // Plain text payload
            setReceiveCode(decodedText);
            setShowQRScanner(false);
          }
        },
        () => { /* Ignore read errors */ }
      ).catch(console.error);

      return () => {
        if (html5QrCodeRef.current) {
          try {
            if (html5QrCodeRef.current.isScanning) {
              html5QrCodeRef.current.stop().then(() => html5QrCodeRef.current?.clear()).catch(console.error);
            }
          } catch { /* Handle rapid unmount safely */ }
        }
      };
    } else {
      if (html5QrCodeRef.current && html5QrCodeRef.current.isScanning) {
        html5QrCodeRef.current.stop().then(() => html5QrCodeRef.current?.clear()).catch(console.error);
      }
    }
  }, [showQRScanner]);

  // LAN Discovery via BroadcastChannel — include shareCode so others can auto-connect
  const deviceId = useRef(Math.random().toString(36).substring(2, 8));
  useEffect(() => {
    const bc = new BroadcastChannel('mephisto-share-discovery');
    bcRef.current = bc;

    const announce = () => {
      bc.postMessage({
        type: 'announce',
        id: deviceId.current,
        name: `Device-${deviceId.current}`,
        time: Date.now(),
        code: shareCode || undefined,  // share the room code if sender
        mode: mode,
      });
    };

    bc.onmessage = (e) => {
      const data = e.data;
      if (data.type === 'announce' && data.id !== deviceId.current) {
        setNearbyDevices(prev => {
          const exists = prev.find(d => d.id === data.id);
          if (exists) return prev.map(d => d.id === data.id ? { ...d, time: data.time, code: data.code || d.code } : d);
          return [...prev, { id: data.id, name: data.name, time: data.time, code: data.code }];
        });
      }
    };

    announce();
    const interval = setInterval(announce, 3000);
    const cleanup = setInterval(() => {
      setNearbyDevices(prev => prev.filter(d => Date.now() - d.time < 10000));
    }, 10000);

    return () => {
      clearInterval(interval);
      clearInterval(cleanup);
      bc.close();
    };
  }, [shareCode, mode]);

  const formatTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const playSound = useCallback(() => {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880; osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.5);
      setTimeout(() => {
        const o2 = ctx.createOscillator(); const g2 = ctx.createGain();
        o2.connect(g2); g2.connect(ctx.destination);
        o2.frequency.value = 1320; o2.type = 'sine';
        g2.gain.setValueAtTime(0.3, ctx.currentTime);
        g2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
        o2.start(ctx.currentTime); o2.stop(ctx.currentTime + 0.6);
      }, 200);
    } catch { /* silent fallback */ }
  }, []);

  const EMOJIS = ['👍', '❤️', '😂', '🔥', '👏', '😮', '🎉', '💯'];

  const resetConnection = () => {
    if (connRef.current) {
      connRef.current.close();
      connRef.current = null;
    }
    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }
    setIsConnected(false);
    setTransferProgress(-1);
    setFileMeta(null);
    fileMetaRef.current = null;
    receivedChunksRef.current = [];
    receivedBytesRef.current = 0;
    setCompletedFile(null);
    setChatMessages([]);
    setErrorStatus(null);
    setConnTime(0);
    setSelfDestructSec(0);
    setPeerCount(0);
    // Don't clear shareCode here — it breaks the send mode display
    multiConnsRef.current.forEach(c => { try { c.close(); } catch { /* ignore */ } });
    multiConnsRef.current = [];
    if (selfDestructRef.current) { clearInterval(selfDestructRef.current); selfDestructRef.current = null; }
  };

  const handleCopy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(shareCode);
      } else {
        // Fallback for non-HTTPS
        const ta = document.createElement('textarea');
        ta.value = shareCode;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  // ---------------------------------------------------------------------------
  // SENDER ALGORITHM
  // ---------------------------------------------------------------------------
  const sendChunk = useCallback(async (offset: number, targetConn?: DataConnection) => {
    try {
      const file = fileToShareRef.current;
      const conn = targetConn || connRef.current;
      if (!file || !conn) return;

      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const slice = file.slice(offset, end);

      const buffer = await slice.arrayBuffer();

      // Double Encryption (XOR Stream Scramble)
      const scrambled = new Uint8Array(buffer);
      const pinStr = shareCode.split('#')[1] || "0";
      const pin = parseInt(pinStr) || 1024;
      for (let i = 0; i < scrambled.length; i++) {
        scrambled[i] ^= (pin % 256);
      }

      conn.send({
        type: 'chunk',
        buffer: scrambled.buffer,
        offset: offset
      });

      const progress = Math.round((end / file.size) * 100);
      setTransferProgress(end === file.size ? 100 : Math.min(99, progress));
    } catch (err: any) {
      console.error('sendChunk Error:', err);
      setErrorStatus('Failed to send file chunk: ' + err.message);
    }
  }, [shareCode]);

  const initSender = useCallback(() => {
    if (!shareCode) return;

    resetConnection();
    setErrorStatus(null);

    const cleanCode = shareCode.split('#')[0].replace(/-/g, '').toLowerCase();
    const peer = new Peer(`mephisto-${cleanCode}`, {
      debug: 2
    });

    peer.on('open', (id) => {
      console.log('Sender is ready. Listening on ID:', id);
    });

    peer.on('connection', (conn) => {
      connRef.current = conn;
      multiConnsRef.current.push(conn);
      setPeerCount(prev => prev + 1);

      conn.on('open', () => {
        setIsConnected(true);
      });

      conn.on('data', (data: any) => {
        console.log('Sender received data:', data.type);
        if (data.type === 'request-metadata') {
          if (fileToShareRef.current) {
            console.log('Sender replying with metadata...');
            conn.send({
              type: 'metadata',
              name: fileToShareRef.current.name,
              size: fileToShareRef.current.size,
              mime: fileToShareRef.current.type
            });
          }
        }
        else if (data.type === 'request-chunk') {
          sendChunk(data.offset, conn);
        }
        else if (data.type === 'chat') {
          setChatMessages(prev => [...prev, { id: Date.now(), text: data.text, sender: 'peer' }]);
        }
      });

      conn.on('close', () => {
        multiConnsRef.current = multiConnsRef.current.filter(c => c !== conn);
        setPeerCount(multiConnsRef.current.length);
        if (multiConnsRef.current.length === 0) {
          setIsConnected(false);
          setErrorStatus('Connection lost.');
        }
      });

      conn.on('error', (err) => {
        console.error('Conn Error:', err);
        setErrorStatus(err.message);
      });
    });

    peerRef.current = peer;
  }, [shareCode, sendChunk]);

  useEffect(() => {
    if (mode === 'send' && shareCode && !peerRef.current) {
      initSender();
    }
  }, [mode, shareCode, initSender]);


  // ---------------------------------------------------------------------------
  // RECEIVER ALGORITHM
  // ---------------------------------------------------------------------------
  const handleConnectReceiver = (e: React.FormEvent) => {
    e.preventDefault();
    if (!receiveCode) return;

    resetConnection();
    setErrorStatus(null);
    setTransferProgress(0); // Show connection loader

    const parts = receiveCode.trim().toLowerCase().split('#');
    const cleanCode = parts[0].replace('-', '');
    const targetId = `mephisto-${cleanCode}`;

    const peer = new Peer({ debug: 2 });

    peer.on('open', () => {
      // Attempt connection to sender
      const conn = peer.connect(targetId, {
        reliable: true
      });
      connRef.current = conn;

      conn.on('open', () => {
        setIsConnected(true);
        console.log('Receiver data channel open. Starting robust handshake...');

        // Robust handshake: keep asking every 500ms until sender responds
        const handshakeInterval = setInterval(() => {
          if (fileMetaRef.current || !conn.open) {
            clearInterval(handshakeInterval);
            return;
          }
          console.log('Receiver requesting metadata...');
          conn.send({ type: 'request-metadata' });
        }, 500);
      });

      conn.on('data', (data: any) => {
        try {
          if (data.type === 'metadata') {
            console.log('Receiver got metadata:', data);
            // Allow multiple metadata packets safely but only initialize once if needed
            if (!fileMetaRef.current) {
              const meta = {
                name: data.name,
                size: data.size,
                type: data.mime
              };
              setFileMeta(meta);
              fileMetaRef.current = meta;
              receivedChunksRef.current = [];
              receivedBytesRef.current = 0;
              setTransferProgress(0);

              // Request first chunk
              console.log('Receiver requesting first chunk...');
              conn.send({ type: 'request-chunk', offset: 0 });
            }
          }
          else if (data.type === 'chunk') {
            const buffer = data.buffer;
            if (!buffer) throw new Error("Empty buffer received.");
            console.log(`Receiver received chunk: offset ${data.offset}, size ${buffer.byteLength}`);

            // Double Encryption Unscramble
            const scrambled = new Uint8Array(buffer);
            const pinStr = receiveCode.split('#')[1] || "0";
            const pin = parseInt(pinStr) || 1024;
            for (let i = 0; i < scrambled.length; i++) {
              scrambled[i] ^= (pin % 256);
            }

            // Handle different ArrayBuffer implementations/shapes passing through WebRTC
            const byteLength = scrambled.buffer.byteLength !== undefined ? scrambled.buffer.byteLength : (scrambled.buffer as any).length !== undefined ? (scrambled.buffer as any).length : 0;
            if (byteLength === 0) throw new Error("Received chunk has zero length.");

            receivedChunksRef.current.push(scrambled.buffer);
            receivedBytesRef.current += byteLength;

            const meta = fileMetaRef.current;
            if (meta) {
              const progress = Math.round((receivedBytesRef.current / meta.size) * 100);

              if (receivedBytesRef.current < meta.size) {
                setTransferProgress(Math.min(99, progress));
                // Request next chunk
                conn.send({ type: 'request-chunk', offset: receivedBytesRef.current });
              } else {
                setTransferProgress(100);
                // Transfer complete
                finalizeDownload(meta.name, meta.type);
              }
            }
          }
          else if (data.type === 'chat') {
            setChatMessages(prev => [...prev, { id: Date.now(), text: data.text, sender: 'peer' }]);
          }
        } catch (err: any) {
          console.error('Receive Data Error:', err);
          setErrorStatus('Data parsing error: ' + err.message);
        }
      });

      conn.on('close', () => {
        if (transferProgress < 100 && transferProgress > 0) {
          setErrorStatus('Connection closed unexpectedly.');
        }
        setIsConnected(false);
      });

      conn.on('error', (err) => {
        setErrorStatus('Connection error: ' + err.message);
      });
    });

    peer.on('error', (err) => {
      console.error('Peer Error:', err);
      setErrorStatus('Error: Could not find or connect to that peer. Check the code.');
      setTransferProgress(-1);
    });

    peerRef.current = peer;
  };

  const finalizeDownload = useCallback(async (name: string, type: string) => {
    const blob = new Blob(receivedChunksRef.current, { type: type || 'application/octet-stream' });
    setCompletedFile({ blob, name, type });
    setTransferProgress(100);
    setSessionTransfers(prev => prev + 1);
    playSound();
  }, [playSound]);

  // ---------------------------------------------------------------------------
  // UI HANDLERS & BUNDLING
  // ---------------------------------------------------------------------------
  const processFiles = async (files: any[]) => {
    if (files.length === 0) return;

    // Check if we need to zip: >1 file OR it has a custom path/folder structure
    const needsZip = files.length > 1 || files.some(f => f.customPath?.includes('/') || (f.webkitRelativePath && f.webkitRelativePath.includes('/')));

    if (!needsZip) {
      const file = files[0];
      setFileToShare(file);
      fileToShareRef.current = file;
    } else {
      setIsZipping(true);
      const zip = new JSZip();

      files.forEach(f => {
        const path = f.customPath || (f.webkitRelativePath && f.webkitRelativePath.includes('/') ? f.webkitRelativePath : f.name);
        zip.file(path, f);
      });

      const content = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 5 }
      }, (meta) => {
        setZipProgress(meta.percent);
      });

      const bundledFile = new File([content], `mephisto-bundle-${Math.floor(Date.now() / 1000)}.zip`, { type: 'application/zip' });
      setIsZipping(false);
      setFileToShare(bundledFile);
      fileToShareRef.current = bundledFile;
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(Array.from(e.target.files));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const scanEntry = async (entry: any, path: string = ''): Promise<any[]> => {
    if (entry.isFile) {
      return new Promise<any[]>((resolve) => {
        entry.file((file: File) => {
          (file as any).customPath = path + file.name;
          resolve([file]);
        });
      });
    } else if (entry.isDirectory) {
      const dirReader = entry.createReader();
      return new Promise<any[]>((resolve) => {
        const readAll = async () => {
          let allFiles: any[] = [];
          const readEntries = () => new Promise<any[]>((res) => dirReader.readEntries(res));

          let entries = await readEntries();
          while (entries.length > 0) {
            for (const cEntry of entries) {
              const files = await scanEntry(cEntry, path + entry.name + '/');
              allFiles = allFiles.concat(files);
            }
            entries = await readEntries();
          }
          resolve(allFiles);
        };
        readAll();
      });
    }
    return [];
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    if (e.dataTransfer.items) {
      const items = Array.from(e.dataTransfer.items);
      let allFiles: any[] = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : (item as any).getAsEntry ? (item as any).getAsEntry() : null;
          if (entry) {
            const files = await scanEntry(entry);
            allFiles = allFiles.concat(files);
          } else {
            const file = item.getAsFile();
            if (file) allFiles.push(file);
          }
        }
      }
      processFiles(allFiles);
    } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(Array.from(e.dataTransfer.files));
    }
  };

  // Auto-connect to a nearby device's room
  const connectToDevice = (code: string) => {
    setMode('receive');
    setReceiveCode(code);
    // Simulate form submit after a tick
    setTimeout(() => {
      // Trigger connection manually
      resetConnection();
      setErrorStatus(null);
      setTransferProgress(0);

      const parts = code.trim().toLowerCase().split('#');
      const cleanCode = parts[0].replace('-', '');
      const targetId = `mephisto-${cleanCode}`;

      const peer = new Peer({ debug: 2 });

      peer.on('open', () => {
        const conn = peer.connect(targetId, { reliable: true });
        connRef.current = conn;

        conn.on('open', () => {
          setIsConnected(true);
          const handshakeInterval = setInterval(() => {
            if (fileMetaRef.current || !conn.open) { clearInterval(handshakeInterval); return; }
            conn.send({ type: 'request-metadata' });
          }, 500);
        });

        conn.on('data', (data: any) => {
          try {
            if (data.type === 'metadata' && !fileMetaRef.current) {
              const meta = { name: data.name, size: data.size, type: data.mime };
              setFileMeta(meta);
              fileMetaRef.current = meta;
              receivedChunksRef.current = [];
              receivedBytesRef.current = 0;
              setTransferProgress(0);
              conn.send({ type: 'request-chunk', offset: 0 });
            } else if (data.type === 'chunk') {
              const buffer = data.buffer;
              if (!buffer) throw new Error("Empty buffer received.");
              const scrambled = new Uint8Array(buffer);
              const pinStr = code.split('#')[1] || "0";
              const pin = parseInt(pinStr) || 1024;
              for (let i = 0; i < scrambled.length; i++) { scrambled[i] ^= (pin % 256); }
              const byteLength = scrambled.buffer.byteLength !== undefined ? scrambled.buffer.byteLength : 0;
              receivedChunksRef.current.push(scrambled.buffer);
              receivedBytesRef.current += byteLength;
              const meta = fileMetaRef.current;
              if (meta) {
                const progress = Math.round((receivedBytesRef.current / meta.size) * 100);
                if (receivedBytesRef.current < meta.size) {
                  setTransferProgress(Math.min(99, progress));
                  conn.send({ type: 'request-chunk', offset: receivedBytesRef.current });
                } else {
                  setTransferProgress(100);
                  finalizeDownload(meta.name, meta.type);
                }
              }
            } else if (data.type === 'chat') {
              setChatMessages(prev => [...prev, { id: Date.now(), text: data.text, sender: 'peer' }]);
            }
          } catch (err: any) { setErrorStatus('Data parsing error: ' + err.message); }
        });

        conn.on('close', () => { setIsConnected(false); });
        conn.on('error', (err) => { setErrorStatus('Connection error: ' + err.message); });
      });

      peer.on('error', () => {
        setErrorStatus(t('errorPeer'));
        setTransferProgress(-1);
      });

      peerRef.current = peer;
    }, 100);
  };

  const broadcastToAll = (msg: any) => {
    if (mode === 'send') {
      multiConnsRef.current.forEach(c => { try { if (c.open) c.send(msg); } catch { /* ignore */ } });
    } else if (connRef.current?.open) {
      connRef.current.send(msg);
    }
  };

  const sendChatMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    const msg = chatInput.trim();
    broadcastToAll({ type: 'chat', text: msg });
    setChatMessages(prev => [...prev, { id: Date.now(), text: msg, sender: 'me' }]);
    setChatInput('');
    setShowEmojiPicker(false);
  };

  const sendEmoji = (emoji: string) => {
    broadcastToAll({ type: 'chat', text: emoji });
    setChatMessages(prev => [...prev, { id: Date.now(), text: emoji, sender: 'me' }]);
    setShowEmojiPicker(false);
  };

  const sendClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        broadcastToAll({ type: 'chat', text: `📋 ${text}` });
        setChatMessages(prev => [...prev, { id: Date.now(), text: `📋 ${text}`, sender: 'me' }]);
      }
    } catch { /* clipboard access denied */ }
  };


  return (
    <div className={`min-h-screen flex flex-col items-center justify-center p-4 selection:bg-emerald-500/30 transition-colors duration-300 ${theme === 'light' ? 'bg-slate-100 text-slate-900' : ''}`}>

      {/* Theme & Language Toggle */}
      <div className="fixed top-4 right-4 z-50 flex gap-2">
        {/* Language Dropdown */}
        <div className="relative">
          <button onClick={() => setShowLangPicker(!showLangPicker)} className="p-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-colors flex items-center gap-1.5" title="Language">
            <Globe className="w-5 h-5 text-cyan-400" />
            <span className="text-xs text-slate-300 hidden sm:inline">{SUPPORTED_LANGS.find(l => l.code === lang)?.flag}</span>
            <ChevronDown className="w-3 h-3 text-slate-500" />
          </button>
          <AnimatePresence>
            {showLangPicker && (
              <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }}
                className="absolute right-0 top-12 bg-black/90 backdrop-blur-xl border border-white/10 rounded-xl overflow-hidden shadow-2xl min-w-[160px] z-50">
                {SUPPORTED_LANGS.map(l => (
                  <button key={l.code} onClick={() => { setLang(l.code); localStorage.setItem('ms-lang', l.code); setShowLangPicker(false); }}
                    className={`w-full px-4 py-2.5 text-left text-sm flex items-center gap-3 hover:bg-white/10 transition-colors ${lang === l.code ? 'bg-white/5 text-white' : 'text-slate-400'}`}>
                    <span className="text-lg">{l.flag}</span>
                    <span>{l.label}</span>
                    {lang === l.code && <Check className="w-3 h-3 text-emerald-400 ml-auto" />}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <button onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} className="p-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-colors" title="Toggle Theme">
          {theme === 'dark' ? <Sun className="w-5 h-5 text-yellow-400" /> : <Moon className="w-5 h-5 text-slate-600" />}
        </button>
      </div>

      {/* Background Decor */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute top-[20%] left-[50%] -translate-x-1/2 w-[60vw] h-[60vw] max-w-[800px] max-h-[800px] bg-emerald-500/[0.03] rounded-full blur-3xl mix-blend-screen" />
        <div className="absolute bottom-[10%] left-[20%] w-[40vw] h-[40vw] max-w-[600px] max-h-[600px] bg-cyan-500/[0.03] rounded-full blur-3xl mix-blend-screen" />
      </div>

      <div className="z-10 w-full max-w-lg">
        {/* Header */}
        <div className="flex flex-col items-center justify-center mb-12 text-center">
          <div className="w-16 h-16 bg-white/[0.03] border border-white/10 rounded-2xl flex items-center justify-center mb-6 shadow-2xl relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-tr from-emerald-500/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <Activity className="w-8 h-8 text-emerald-500" />
            {isConnected ? (
              <div className="absolute inset-0 border-2 border-emerald-500/50 rounded-2xl animate-pulse" />
            ) : (
              <div className="radar-sweep opacity-50" />
            )}
          </div>
          <h1 className="text-4xl font-black tracking-tight mb-3">
            Mephisto<span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-500 to-purple-500">Vault</span>
          </h1>
          <p className="text-base text-slate-400 font-medium">
            {t('subtitle')}
            <br /> <span className="text-slate-500">{t('subtitle2')}</span>
          </p>
          {isConnected && (
            <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} className="mt-4 flex items-center gap-2 bg-green-500/10 border border-green-500/20 text-green-400 text-xs font-mono px-3 py-1.5 rounded-full">
              <Clock className="w-3 h-3" /> {t('connected')}: {formatTime(connTime)}
            </motion.div>
          )}
        </div>

        {/* Main Panel */}
        <AnimatePresence mode="wait">
          {mode === 'idle' && (
            <motion.div
              key="idle"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="space-y-4"
            >
              {/* Send / Receive Buttons */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <button
                  onClick={() => setMode('send')}
                  className="glass-panel p-8 flex flex-col items-center justify-center hover:bg-white/[0.04] hover:border-emerald-500/30 transition-all group cursor-pointer"
                >
                  <div className="w-12 h-12 rounded-full bg-emerald-500/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                    <Upload className="w-6 h-6 text-emerald-500" />
                  </div>
                  <span className="text-lg font-bold text-white mb-1">{t('sendFiles')}</span>
                  <span className="text-sm text-slate-400 text-center">{t('sendDesc')}</span>
                </button>

                <button
                  onClick={() => setMode('receive')}
                  className="glass-panel p-8 flex flex-col items-center justify-center hover:bg-white/[0.04] hover:border-cyan-500/30 transition-all group cursor-pointer"
                >
                  <div className="w-12 h-12 rounded-full bg-cyan-500/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                    <Download className="w-6 h-6 text-cyan-500" />
                  </div>
                  <span className="text-lg font-bold text-white mb-1">{t('receiveFiles')}</span>
                  <span className="text-sm text-slate-400 text-center">{t('receiveDesc')}</span>
                </button>
              </div>

              {/* Hero Feature Cards */}
              <div className="grid grid-cols-3 gap-3">
                <div className="glass-panel p-4 text-center group hover:border-emerald-500/20 transition-all">
                  <Zap className="w-6 h-6 text-emerald-400 mx-auto mb-2 group-hover:scale-110 transition-transform" />
                  <p className="text-xs font-bold text-white mb-1">{t('heroFeature1')}</p>
                  <p className="text-[10px] text-slate-500 leading-tight">{t('heroDesc1')}</p>
                </div>
                <div className="glass-panel p-4 text-center group hover:border-red-500/20 transition-all">
                  <Flame className="w-6 h-6 text-red-400 mx-auto mb-2 group-hover:scale-110 transition-transform" />
                  <p className="text-xs font-bold text-white mb-1">{t('heroFeature2')}</p>
                  <p className="text-[10px] text-slate-500 leading-tight">{t('heroDesc2')}</p>
                </div>
                <div className="glass-panel p-4 text-center group hover:border-purple-500/20 transition-all">
                  <EyeOff className="w-6 h-6 text-purple-400 mx-auto mb-2 group-hover:scale-110 transition-transform" />
                  <p className="text-xs font-bold text-white mb-1">{t('heroFeature3')}</p>
                  <p className="text-[10px] text-slate-500 leading-tight">{t('heroDesc3')}</p>
                </div>
              </div>

              {/* File Size Note */}
              <div className="flex items-center justify-center gap-2 text-[11px] text-slate-500 bg-white/[0.02] border border-white/5 px-4 py-2 rounded-xl">
                <Shield className="w-3.5 h-3.5 text-emerald-500/60" />
                {t('maxFileNote')}
              </div>

              {/* Session Stats */}
              {sessionTransfers > 0 && (
                <div className="flex items-center justify-center gap-2 text-[11px] text-emerald-400/70 font-mono">
                  <Activity className="w-3 h-3" /> {sessionTransfers} {t('stats')}
                </div>
              )}
            </motion.div>
          )}

          {/* SEND MODE */}
          {mode === 'send' && (
            <motion.div
              key="send"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, y: 10 }}
              className="glass-panel overflow-hidden"
            >
              <div className="p-4 border-b border-white/5 flex items-center justify-between">
                <h2 className="text-white font-bold flex items-center gap-2">
                  <Upload className="w-4 h-4 text-emerald-500" /> {t('sendTitle')}
                </h2>
                <button onClick={() => { setShareCode(''); setFileToShare(null); resetConnection(); setMode('idle'); }} className="text-slate-400 hover:text-white p-1 rounded-md hover:bg-white/10 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-6 md:p-8">
                {!fileToShare ? (
                  isZipping ? (
                    <div className="flex flex-col items-center justify-center p-12 text-center bg-black/40 border-2 border-dashed border-emerald-500/50 rounded-2xl">
                      <div className="relative w-20 h-20 mb-6">
                        <div className="absolute inset-0 border-4 border-emerald-500/30 rounded-full animate-spin"></div>
                        <div className="absolute inset-0 flex items-center justify-center font-bold text-emerald-500">{Math.round(zipProgress)}%</div>
                      </div>
                      <h3 className="text-xl font-bold text-white mb-2">{t('compressing')}</h3>
                      <p className="text-sm text-slate-400">{t('compressSub')}</p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3 w-full">
                      {/* Unified Drop Zone — accepts both files and folders */}
                      <div
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        className={`relative w-full border-2 border-dashed rounded-2xl p-8 transition-all group flex flex-col items-center text-center overflow-hidden
                           ${isDragging ? 'border-emerald-500 bg-emerald-500/10 scale-105 shadow-[0_0_30px_rgba(16,185,129,0.2)]' : 'border-white/10 hover:border-emerald-500/30 hover:bg-emerald-500/5'}`}
                      >
                        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
                        <input
                          ref={folderInputRef}
                          type="file"
                          {...{ webkitdirectory: "", directory: "" } as any}
                          multiple
                          className="hidden"
                          onChange={handleFileChange}
                        />
                        <motion.div animate={{ y: isDragging ? -10 : 0 }} className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 transition-colors ${isDragging ? 'bg-emerald-500/40' : 'bg-white/5 group-hover:bg-emerald-500/20'}`}>
                          <Upload className={`w-8 h-8 transition-colors ${isDragging ? 'text-white' : 'text-slate-400 group-hover:text-emerald-500'}`} />
                        </motion.div>
                        <p className="text-white font-bold text-lg mb-1">{isDragging ? t('dropHot') : t('dropHere')}</p>
                        <p className="text-slate-500 text-sm mb-4">{t('dropSub')}</p>

                        {/* Inline file/folder selection buttons */}
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                            className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-emerald-500/20 border border-white/10 hover:border-emerald-500/30 rounded-xl text-sm text-slate-300 hover:text-white transition-all"
                          >
                            <FileIcon className="w-4 h-4 text-emerald-400" /> {t('sendTitle')}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); folderInputRef.current?.click(); }}
                            className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-cyan-500/20 border border-white/10 hover:border-cyan-500/30 rounded-xl text-sm text-slate-300 hover:text-white transition-all"
                          >
                            <Folder className="w-4 h-4 text-cyan-400" /> {t('selectFolder')}
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                ) : (
                  // Step 2: Show Code & Status
                  <div className="flex flex-col items-center">
                    {/* File Info */}
                    <div className="w-full flex items-center gap-4 bg-black/40 border border-white/5 rounded-xl p-4 mb-6">
                      <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
                        <FileIcon className="w-5 h-5 text-emerald-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-white font-bold text-sm truncate">{fileToShare.name}</p>
                        <p className="text-slate-400 text-xs">{formatBytes(fileToShare.size)}</p>
                      </div>
                      {transferProgress <= 0 && !isConnected && (
                        <button onClick={() => setFileToShare(null)} className="text-slate-500 hover:text-white p-2">
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    {errorStatus && (
                      <div className="w-full bg-red-500/10 border border-red-500/20 text-red-400 text-sm p-3 rounded-lg mb-6 text-center">
                        {errorStatus}
                      </div>
                    )}

                    {(!isConnected && !errorStatus) && (
                      <div className="text-center mb-6">
                        <p className="text-sm text-slate-400 mb-4">{t('shareCode')}</p>
                        <div className="flex items-center gap-2 justify-center">
                          <div className="bg-black/60 border border-white/10 px-6 py-4 rounded-xl font-mono text-3xl font-black tracking-widest text-emerald-500 shadow-inner">
                            {shareCode}
                          </div>
                          <div className="flex flex-col gap-2">
                            <button onClick={handleCopy} className="bg-white/5 hover:bg-white/10 border border-white/5 p-3 rounded-xl transition-colors group" title="Copy Code">
                              {copied ? <Check className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5 text-slate-400 group-hover:text-white" />}
                            </button>
                            <button onClick={() => setShowQR(!showQR)} className="bg-white/5 hover:bg-white/10 border border-white/5 p-3 rounded-xl transition-colors group" title="Show QR Code">
                              <QrCode className="w-5 h-5 text-slate-400 group-hover:text-white" />
                            </button>
                          </div>
                        </div>
                        {/* QR Code */}
                        <AnimatePresence>
                          {showQR && (
                            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mt-4 flex justify-center">
                              <div className="bg-white p-4 rounded-2xl shadow-lg">
                                <QRCodeSVG value={`${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(shareCode)}`} size={180} bgColor="#fff" fgColor="#0f172a" level="H" />
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    )}

                    {/* File Preview */}
                    {previewUrl && (
                      <div className="w-full mb-4 rounded-xl overflow-hidden border border-white/10 max-h-40">
                        <img src={previewUrl} alt="Preview" className="w-full h-full object-cover" />
                      </div>
                    )}

                    <div className="w-full flex flex-col items-center justify-center py-4">
                      {/* Multi-Peer Room Badge */}
                      {peerCount > 0 && (
                        <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} className="mb-4 flex items-center gap-2 bg-purple-500/10 border border-purple-500/20 text-purple-400 text-xs font-mono px-3 py-1.5 rounded-full">
                          <Users className="w-3 h-3" /> {peerCount} {t('peers')}
                        </motion.div>
                      )}
                      {isConnected ? (
                        transferProgress >= 100 ? (
                          <div className="text-center">
                            <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-3">
                              <Check className="w-8 h-8 text-green-500" />
                            </div>
                            <p className="text-green-500 font-bold">{t('complete')}</p>
                            {selfDestructSec > 0 && (
                              <div className="mt-2 flex items-center gap-2 text-red-400 text-xs font-mono animate-pulse">
                                <Bomb className="w-3 h-3" /> {t('selfDestruct')} {selfDestructSec}s
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="w-full">
                            <div className="flex justify-between text-sm mb-2 font-mono">
                              <span className="text-emerald-500 font-bold animate-pulse">{t('sending')} 🔐</span>
                              <span className="text-slate-300"><AnimatedCounter value={transferProgress} /></span>
                            </div>
                            <div className="w-full h-3 bg-white/5 rounded-full overflow-hidden border border-white/5">
                              <div
                                className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 rounded-full transition-all duration-300 ease-out"
                                style={{ width: `${transferProgress}%` }}
                              />
                            </div>
                          </div>
                        )
                      ) : (
                        <div className="flex items-center gap-2 text-emerald-500/80 mt-2">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span className="text-sm font-mono animate-pulse">{t('waiting')}</span>
                        </div>
                      )}
                    </div>

                  </div>
                )}
              </div>
            </motion.div>
          )}

          {/* RECEIVE MODE */}
          {mode === 'receive' && (
            <motion.div
              key="receive"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, y: 10 }}
              className="glass-panel overflow-hidden"
            >
              <div className="p-4 border-b border-white/5 flex items-center justify-between">
                <h2 className="text-white font-bold flex items-center gap-2">
                  <Download className="w-4 h-4 text-cyan-500" /> {t('receiveTitle')}
                </h2>
                <button onClick={() => setMode('idle')} className="text-slate-400 hover:text-white p-1 rounded-md hover:bg-white/10 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="p-6 md:p-8">

                {errorStatus && (
                  <div className="w-full bg-red-500/10 border border-red-500/20 text-red-400 text-sm p-3 rounded-lg mb-6 text-center">
                    {errorStatus}
                  </div>
                )}

                {(!isConnected && transferProgress === -1) ? (
                  <div className="relative">
                    <form onSubmit={handleConnectReceiver}>
                      <label className="block text-sm font-bold tracking-wide text-slate-400 uppercase mb-3">{t('connCode')}</label>
                      <div className="flex gap-2">
                        <input
                          autoFocus
                          type="text"
                          value={receiveCode}
                          onChange={(e) => setReceiveCode(e.target.value)}
                          placeholder="e.g. abc-xyz#1234"
                          className="flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-center text-xl tracking-widest focus:outline-none focus:border-cyan-500/50 transition-colors font-mono"
                          maxLength={13}
                        />
                        <button
                          type="button"
                          onClick={() => setShowQRScanner(!showQRScanner)}
                          className={`px-4 rounded-xl flex items-center justify-center transition-colors border ${showQRScanner ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-white/5 text-slate-400 hover:text-white border-white/10 hover:bg-white/10'}`}
                          title="Scan QR Code"
                        >
                          <Camera className="w-6 h-6" />
                        </button>
                        <button
                          type="submit"
                          disabled={receiveCode.length < 11}
                          className="bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 font-bold rounded-xl transition-colors"
                        >
                          {t('connect')}
                        </button>
                      </div>
                      <div className="mt-8 flex items-start gap-3 bg-cyan-500/5 border border-cyan-500/10 p-4 rounded-xl">
                        <Shield className="w-5 h-5 text-cyan-400 mt-0.5 shrink-0" />
                        <p className="text-xs text-slate-400 leading-relaxed">
                          Once connected, files are transferred securely via WebRTC.
                          The transfer is <strong className="text-slate-200">end-to-end encrypted</strong> and never passes through any storage servers.
                        </p>
                      </div>
                    </form>

                    {/* QR Scanner Overlay */}
                    <AnimatePresence>
                      {showQRScanner && (
                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mt-4 overflow-hidden rounded-xl border border-white/10 bg-black/50">
                          <div className="p-2 bg-white/5 flex items-center justify-between border-b border-white/5">
                            <span className="text-sm font-bold text-slate-300 flex items-center gap-2"><QrCode className="w-4 h-4" /> {t('scanQR')}</span>
                            <button onClick={() => setShowQRScanner(false)} className="text-slate-400 hover:text-white p-1 rounded-md transition-colors"><X className="w-4 h-4" /></button>
                          </div>
                          <div id="qr-reader" className="w-full bg-black min-h-[250px]" ref={qrRegionRef}></div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                ) : (
                  <div className="flex flex-col items-center py-4">
                    {fileMeta && (
                      <div className="w-full flex items-center gap-4 bg-black/40 border border-white/5 rounded-xl p-4 mb-8">
                        <div className="w-10 h-10 rounded-lg bg-cyan-500/10 flex items-center justify-center shrink-0">
                          <FileIcon className="w-5 h-5 text-cyan-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-white font-bold text-sm truncate">{fileMeta.name}</p>
                          <p className="text-slate-400 text-xs">{formatBytes(fileMeta.size)}</p>
                        </div>
                      </div>
                    )}

                    {!fileMeta && transferProgress === 0 && !errorStatus && (
                      <div className="flex items-center gap-3 text-cyan-500/80 mb-6">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        <span className="font-mono animate-pulse">Connecting to sender & requesting file...</span>
                      </div>
                    )}

                    {fileMeta && transferProgress >= 0 && transferProgress < 100 && (
                      <div className="w-full">
                        <div className="flex justify-between text-sm mb-2 font-mono">
                          <span className="text-cyan-500 font-bold animate-pulse">Decrypting & Receiving... 🔐</span>
                          <span className="text-slate-300"><AnimatedCounter value={transferProgress} /></span>
                        </div>
                        <div className="w-full h-3 bg-white/5 rounded-full overflow-hidden border border-white/5">
                          <div
                            className="h-full bg-gradient-to-r from-cyan-600 to-cyan-400 rounded-full transition-all duration-300 ease-out"
                            style={{ width: `${transferProgress}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {transferProgress >= 100 && completedFile && (
                      <div className="text-center mt-2">
                        <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-4">
                          <Check className="w-8 h-8 text-green-500" />
                        </div>
                        <p className="text-green-500 font-bold text-xl mb-1">{t('complete')}</p>
                        <p className="text-slate-400 text-sm mb-2">{t('readySave')}</p>
                        {selfDestructSec > 0 && (
                          <div className="mb-4 flex items-center justify-center gap-2 text-red-400 text-xs font-mono animate-pulse">
                            <Bomb className="w-3 h-3" /> {t('selfDestruct')} {selfDestructSec}s
                          </div>
                        )}

                        <button
                          onClick={async () => {
                            try {
                              if ('showSaveFilePicker' in window) {
                                const handle = await (window as any).showSaveFilePicker({
                                  suggestedName: completedFile.name,
                                });
                                const writable = await handle.createWritable();
                                await writable.write(completedFile.blob);
                                await writable.close();
                                return; // Success! IDM bypassed completely.
                              }
                            } catch (err: any) {
                              if (err.name !== 'AbortError') {
                                console.error('SaveFilePicker error:', err);
                              }
                              return; // If user cancelled the picker loop, stop here.
                            }

                            // Legacy fallback if File System API is not available
                            const url = URL.createObjectURL(completedFile.blob);
                            const a = document.createElement('a');
                            a.style.display = 'none';
                            a.href = url;
                            a.download = completedFile.name;
                            document.body.appendChild(a);
                            a.click();
                            setTimeout(() => {
                              document.body.removeChild(a);
                              URL.revokeObjectURL(url);
                            }, 100);
                          }}
                          className="bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-400 hover:to-emerald-500 text-white font-bold py-3 px-6 w-full max-w-sm rounded-2xl transition-all shadow-[0_0_20px_rgba(16,185,129,0.3)] hover:shadow-[0_0_30px_rgba(16,185,129,0.5)] flex items-center justify-center mx-auto gap-2 group cursor-pointer"
                        >
                          <Download className="w-5 h-5 shrink-0 group-hover:-translate-y-1 transition-transform" />
                          <span className="truncate max-w-[200px] sm:max-w-[300px]">{t('save')} {completedFile.name}</span>
                        </button>

                        {/* ZIP Content Viewer Toggle */}
                        {zipContents.length > 0 && (
                          <div className="mt-4 w-full max-w-sm mx-auto">
                            <button
                              onClick={() => setShowZipPreview(!showZipPreview)}
                              className="w-full bg-slate-800/50 hover:bg-slate-800 text-slate-300 font-bold py-3 px-6 rounded-2xl border border-white/5 transition-all flex items-center justify-between group"
                            >
                              <div className="flex items-center gap-2">
                                <Archive className="w-5 h-5 text-emerald-400 group-hover:scale-110 transition-transform" />
                                <span>{showZipPreview ? t('closePreview') : t('viewZip')}</span>
                              </div>
                              <Eye className="w-4 h-4 text-slate-500" />
                            </button>

                            <AnimatePresence>
                              {showZipPreview && (
                                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mt-2 overflow-hidden">
                                  <div className="bg-black/60 border border-white/5 rounded-2xl p-2 max-h-64 overflow-y-auto custom-scrollbar text-left text-sm">
                                    {zipContents.map((f, i) => (
                                      <div key={i} className="flex items-center gap-2 py-2 px-3 hover:bg-white/5 rounded-lg transition-colors border-b border-white/5 last:border-0">
                                        {f.dir ? <Folder className="w-4 h-4 text-emerald-400 shrink-0" /> : <FileIcon className="w-4 h-4 text-cyan-400 shrink-0" />}
                                        <div className="flex-1 min-w-0">
                                          <p className="text-slate-300 truncate" title={f.path}>{f.name}</p>
                                          {!f.dir && <p className="text-xs text-slate-500">{formatBytes(f.size)}</p>}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        )}

                        {/* Video Stream Button */}
                        {videoPreviewUrl && (
                          <div className="mt-4 w-full max-w-sm mx-auto">
                            {!showVideoPlayer ? (
                              <button onClick={() => setShowVideoPlayer(true)} className="w-full bg-purple-600 hover:bg-purple-500 text-white font-bold py-3 px-6 rounded-xl transition-all flex items-center justify-center gap-2 group cursor-pointer">
                                <Play className="w-5 h-5 group-hover:scale-110 transition-transform" />
                                {t('streamPlay')}
                              </button>
                            ) : (
                              <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="rounded-xl overflow-hidden border border-purple-500/30 shadow-lg shadow-purple-500/10">
                                <div className="bg-black/60 p-2 text-xs text-purple-400 font-mono flex items-center gap-2">
                                  <Radio className="w-3 h-3 animate-pulse" /> {t('streamTitle')}
                                </div>
                                <video src={videoPreviewUrl} controls autoPlay className="w-full max-h-60 bg-black" />
                              </motion.div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Ghost Chat Panel */}
        {mode !== 'idle' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className={`mt-6 glass-panel overflow-hidden border ${isConnected ? 'border-purple-500/30 shadow-[0_0_20px_rgba(168,85,247,0.15)]' : 'border-white/10 opacity-70'} relative transition-all duration-500`}
          >
            {!isConnected && (
              <div className="absolute inset-0 z-10 bg-black/60 backdrop-blur-[2px] flex items-center justify-center">
                <div className="flex items-center gap-2 text-white/70 font-mono text-sm">
                  <Loader2 className="w-4 h-4 animate-spin text-purple-500" />
                  Waiting for peer...
                </div>
              </div>
            )}
            <div className="bg-black/40 p-3 border-b border-white/5 flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-300 font-bold text-sm">
                <MessageSquare className="w-4 h-4 text-purple-500" />
                {t('ghostChat')}
              </div>
              <div className="flex items-center gap-1 text-[10px] text-purple-500/80 uppercase tracking-widest bg-purple-500/10 px-2 py-1 rounded-md">
                <Lock className="w-3 h-3" /> {t('secure')}
              </div>
            </div>

            <div className="h-48 overflow-y-auto p-4 flex flex-col gap-3 scrollbar-hide">
              {chatMessages.length === 0 ? (
                <div className="h-full flex items-center justify-center text-slate-500 text-sm p-4 text-center italic">
                  {t('chatEmpty')}
                </div>
              ) : (
                chatMessages.map(msg => (
                  <div key={msg.id} className={`max-w-[85%] rounded-xl p-3 text-sm ${msg.sender === 'me' ? 'bg-purple-600/20 text-purple-100 self-end border border-purple-500/20 rounded-tr-sm' : 'bg-black/50 text-slate-300 self-start border border-white/5 rounded-tl-sm shadow-md'}`}>
                    {msg.text}
                  </div>
                ))
              )}
              <div ref={chatEndRef} />
            </div>

            <form onSubmit={sendChatMessage} className="p-3 bg-black/40 border-t border-white/5 flex gap-2 relative">
              {/* Emoji Picker */}
              <AnimatePresence>
                {showEmojiPicker && (
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} className="absolute bottom-full left-3 mb-2 bg-black/90 border border-white/10 rounded-xl p-2 flex gap-1 flex-wrap max-w-[200px] shadow-xl">
                    {EMOJIS.map(e => (
                      <button key={e} type="button" onClick={() => sendEmoji(e)} className="text-xl p-1.5 hover:bg-white/10 rounded-lg transition-colors">{e}</button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
              <button type="button" onClick={() => setShowEmojiPicker(!showEmojiPicker)} className="text-slate-400 hover:text-purple-400 p-2 rounded-lg transition-colors shrink-0" title="Emoji">
                <Smile className="w-4 h-4" />
              </button>
              <button type="button" onClick={sendClipboard} className="text-slate-400 hover:text-purple-400 p-2 rounded-lg transition-colors shrink-0" title="Paste from Clipboard">
                <Clipboard className="w-4 h-4" />
              </button>
              <input
                type="text"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                placeholder="Type a secure message..."
                className="flex-1 bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50 transition-colors"
                maxLength={200}
              />
              <button
                type="submit"
                disabled={!chatInput.trim()}
                className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white p-2 rounded-lg transition-colors flex items-center justify-center w-10 shrink-0"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </motion.div>
        )}

        {/* Nearby Devices Panel */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-6">
          <button onClick={() => setShowNearby(!showNearby)} className="w-full flex items-center justify-center gap-2 text-sm text-slate-400 hover:text-white transition-colors py-2 group">
            <Wifi className={`w-4 h-4 ${nearbyDevices.length > 0 ? 'text-green-500 animate-pulse' : 'text-slate-500'}`} />
            {t('nearby')} {nearbyDevices.length > 0 && <span className="bg-green-500/20 text-green-400 text-xs px-2 py-0.5 rounded-full font-mono">{nearbyDevices.length}</span>}
          </button>
          <AnimatePresence>
            {showNearby && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <div className="glass-panel p-4 mt-2">
                  {nearbyDevices.length === 0 ? (
                    <p className="text-sm text-slate-500 text-center italic">{t('noNearby')}</p>
                  ) : (
                    <div className="space-y-2">
                      {nearbyDevices.map(d => (
                        <div key={d.id} className="flex items-center gap-3 bg-black/30 border border-white/5 rounded-xl p-3">
                          <div className="w-8 h-8 rounded-full bg-green-500/10 flex items-center justify-center">
                            <Wifi className="w-4 h-4 text-green-500" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-white text-sm font-bold">{d.name}</p>
                            <p className="text-slate-500 text-xs font-mono truncate">{d.code ? `Room: ${d.code.split('#')[0]}` : 'Idle'}</p>
                          </div>
                          {d.code ? (
                            <button
                              onClick={() => connectToDevice(d.code!)}
                              className="bg-green-600 hover:bg-green-500 text-white text-xs font-bold px-4 py-2 rounded-lg transition-colors flex items-center gap-1.5 shrink-0"
                            >
                              <Download className="w-3 h-3" /> {t('sendTo')}
                            </button>
                          ) : (
                            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        <div className="mt-8 text-center text-xs text-slate-600 flex items-center justify-center gap-2">
          <Shield className="w-4 h-4" /> {t('footer')}
        </div>

      </div>
    </div>
  );
}

export default App;
