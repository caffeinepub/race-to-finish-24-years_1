import { AnimatePresence, motion } from "motion/react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useActor } from "../hooks/useActor";

// ── Types ─────────────────────────────────────────────────────────────────────

type GameScreen = "START" | "PLAYING" | "WIN" | "REWARD" | "LOSE";

interface Car {
  lane: number; // 0=left, 1=center, 2=right
  x: number;
  y: number;
  width: number;
  height: number;
  targetX: number;
  velocityX: number;
  bounceY: number; // small bounce offset on collision
}

interface Obstacle {
  lane: number;
  y: number; // world distance position (0=start, TOTAL_DISTANCE=finish)
  speed: number; // unused, kept for compatibility
  hit: boolean;
}

interface ConfettiParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  angle: number;
  angularV: number;
  opacity: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TOTAL_DISTANCE = 1000;
const BASE_SPEED = 52; // units/second — reaches finish in ~19s without obstacles
const LANE_COUNT = 3;
const MOVE_DURATION = 0.18; // seconds for lane change
const OBSTACLE_BOUNCE = 30; // units set back on collision
const TIMER_SECONDS = 24;

// Finish line is fixed near top of visible road area (as a fraction of canvas height)
const FINISH_LINE_Y_FRACTION = 0.12;

const GOLD = "#d4a84b";
const BLUE_NEON = "#5eb8f5";
const WHITE_SOFT = "#f0ece0";
const ROAD_BG = "#0d0d12";
const ROAD_SURFACE = "#161620";

const CONFETTI_COLORS = [GOLD, WHITE_SOFT, BLUE_NEON, "#e8d5a3", "#ffffff"];

// ── Helper: draw minimal sleek car ────────────────────────────────────────────

function drawCar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  isPlayer: boolean,
) {
  ctx.save();

  if (isPlayer) {
    // Blue neon glow
    ctx.shadowColor = BLUE_NEON;
    ctx.shadowBlur = 18;
  } else {
    ctx.shadowColor = "rgba(200,80,80,0.4)";
    ctx.shadowBlur = 8;
  }

  const bodyColor = isPlayer ? "#1a2a3a" : "#2a2a2a";
  const accentColor = isPlayer ? BLUE_NEON : "#884444";
  const roofColor = isPlayer ? "#0f1f2e" : "#1a1a1a";

  // Body
  ctx.fillStyle = bodyColor;
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 4);
  ctx.fill();

  // Roof cabin
  const roofW = w * 0.62;
  const roofH = h * 0.38;
  const roofX = cx - roofW / 2;
  const roofY = cy - h / 2 + h * 0.12;
  ctx.fillStyle = roofColor;
  ctx.beginPath();
  ctx.roundRect(roofX, roofY, roofW, roofH, 3);
  ctx.fill();

  // Headlights / tail lights
  const lightY = isPlayer ? cy + h / 2 - 5 : cy - h / 2 + 5;
  ctx.fillStyle = isPlayer ? "rgba(94,184,245,0.9)" : "rgba(220,60,60,0.85)";
  ctx.shadowColor = isPlayer ? BLUE_NEON : "#cc3333";
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.roundRect(cx - w / 2 + 3, lightY - 3, w * 0.28, 5, 2);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(cx + w / 2 - 3 - w * 0.28, lightY - 3, w * 0.28, 5, 2);
  ctx.fill();

  // Side accent stripe
  ctx.shadowBlur = 4;
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(cx - w / 2 + 3, cy);
  ctx.lineTo(cx + w / 2 - 3, cy);
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.restore();
}

// ── Helper: draw road ─────────────────────────────────────────────────────────

function drawRoad(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  roadOffset: number,
  laneWidth: number,
  roadLeft: number,
  roadRight: number,
) {
  const W = canvas.width;
  const H = canvas.height;

  // Background
  ctx.fillStyle = ROAD_BG;
  ctx.fillRect(0, 0, W, H);

  // Road surface
  ctx.fillStyle = ROAD_SURFACE;
  ctx.fillRect(roadLeft, 0, roadRight - roadLeft, H);

  // Subtle road edge glow
  const leftGrad = ctx.createLinearGradient(roadLeft - 15, 0, roadLeft + 20, 0);
  leftGrad.addColorStop(0, "transparent");
  leftGrad.addColorStop(1, "rgba(212,168,75,0.12)");
  ctx.fillStyle = leftGrad;
  ctx.fillRect(roadLeft - 15, 0, 35, H);

  const rightGrad = ctx.createLinearGradient(
    roadRight - 20,
    0,
    roadRight + 15,
    0,
  );
  rightGrad.addColorStop(0, "rgba(212,168,75,0.12)");
  rightGrad.addColorStop(1, "transparent");
  ctx.fillStyle = rightGrad;
  ctx.fillRect(roadRight - 20, 0, 35, H);

  // Road edge lines
  ctx.strokeStyle = "rgba(212,168,75,0.35)";
  ctx.lineWidth = 2;
  ctx.shadowColor = "rgba(212,168,75,0.3)";
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.moveTo(roadLeft, 0);
  ctx.lineTo(roadLeft, H);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(roadRight, 0);
  ctx.lineTo(roadRight, H);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Lane dashes
  const dashH = 40;
  const gapH = 30;
  const cycle = dashH + gapH;
  const offset = ((roadOffset % cycle) + cycle) % cycle;

  ctx.strokeStyle = "rgba(212,168,75,0.22)";
  ctx.lineWidth = 2;
  ctx.setLineDash([dashH, gapH]);

  for (let lane = 1; lane < LANE_COUNT; lane++) {
    const x = roadLeft + lane * laneWidth;
    ctx.beginPath();
    ctx.moveTo(x, -offset + 0);
    ctx.lineTo(x, H + cycle);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

// ── Helper: draw finish line ───────────────────────────────────────────────────

function drawFinishLine(
  ctx: CanvasRenderingContext2D,
  screenY: number,
  roadLeft: number,
  roadRight: number,
  bannerAlpha: number,
) {
  const roadW = roadRight - roadLeft;
  const cellSize = 18;

  // Checkered pattern
  const cols = Math.floor(roadW / cellSize);
  const rows = 3;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const isWhite = (r + c) % 2 === 0;
      ctx.fillStyle = isWhite ? "rgba(255,255,255,0.9)" : "rgba(30,30,30,0.9)";
      ctx.fillRect(
        roadLeft + c * cellSize,
        screenY + r * cellSize,
        cellSize,
        cellSize,
      );
    }
  }

  // Banner
  if (bannerAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = bannerAlpha;
    ctx.shadowColor = GOLD;
    ctx.shadowBlur = 20;
    ctx.fillStyle = "rgba(10,8,4,0.85)";
    const bannerH = 36;
    ctx.beginPath();
    ctx.roundRect(roadLeft, screenY - bannerH - 6, roadW, bannerH, 4);
    ctx.fill();

    ctx.font = `bold 18px "Playfair Display", Georgia, serif`;
    ctx.fillStyle = GOLD;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      "Happy Birthday Kaddu",
      roadLeft + roadW / 2,
      screenY - bannerH / 2 - 6,
    );
    ctx.restore();
  }
}

// ── Confetti ───────────────────────────────────────────────────────────────────

function createConfetti(count: number, width: number): ConfettiParticle[] {
  return Array.from({ length: count }, (_, i) => ({
    x: Math.random() * width,
    y: -20 - Math.random() * 100,
    vx: (Math.random() - 0.5) * 2,
    vy: 1.2 + Math.random() * 2,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    size: 4 + Math.random() * 5,
    angle: Math.random() * Math.PI * 2,
    angularV: (Math.random() - 0.5) * 0.12,
    opacity: 0.7 + Math.random() * 0.3,
  }));
}

function updateConfetti(particles: ConfettiParticle[], height: number) {
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    p.angle += p.angularV;
    p.vy += 0.03; // slight gravity
    if (p.y > height + 20) {
      p.y = -20;
      p.x = Math.random() * 1000;
    }
  }
}

function drawConfetti(
  ctx: CanvasRenderingContext2D,
  particles: ConfettiParticle[],
) {
  for (const p of particles) {
    ctx.save();
    ctx.globalAlpha = p.opacity;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    ctx.restore();
  }
}

// ── Main Component ─────────────────────────────────────────────────────────────

const RacingGame: React.FC = () => {
  const { actor } = useActor();
  const [screen, setScreen] = useState<GameScreen>("START");
  const [muted, setMuted] = useState(false);
  const [winTextVisible, setWinTextVisible] = useState(false);
  const [rewardBtnVisible, setRewardBtnVisible] = useState(false);
  const [loseText1Visible, setLoseText1Visible] = useState(false);
  const [loseText2Visible, setLoseText2Visible] = useState(false);
  const [loseBtnVisible, setLoseBtnVisible] = useState(false);
  const [timerDisplay, setTimerDisplay] = useState(TIMER_SECONDS);
  const [progressDisplay, setProgressDisplay] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const animFrameRef = useRef<number>(0);
  const screenRef = useRef<GameScreen>("START");

  // Game state refs (avoid closure issues in rAF loop)
  const distanceRef = useRef(0);
  const timerRef = useRef(TIMER_SECONDS);
  const lastTimeRef = useRef<number | null>(null);
  const roadOffsetRef = useRef(0);
  const confettiRef = useRef<ConfettiParticle[]>([]);

  const carRef = useRef<Car>({
    lane: 1,
    x: 0,
    y: 0,
    width: 32,
    height: 58,
    targetX: 0,
    velocityX: 0,
    bounceY: 0,
  });

  const obstaclesRef = useRef<Obstacle[]>([]);
  const movingRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // ── Audio setup ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const audio = new Audio(
      "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3",
    );
    audio.loop = true;
    audio.volume = 0.6;
    audio.preload = "auto";
    audioRef.current = audio;
    return () => {
      audio.pause();
    };
  }, []);

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.muted = muted;
  }, [muted]);

  const startAudio = useCallback(() => {
    if (!audioRef.current) return;
    audioRef.current.play().catch(() => {
      /* autoplay blocked, silently ignore */
    });
  }, []);

  // ── Geometry helpers ─────────────────────────────────────────────────────────

  const getLayout = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const W = canvas.width;
    const H = canvas.height;
    const roadW = Math.min(W * 0.72, 320);
    const roadLeft = (W - roadW) / 2;
    const roadRight = roadLeft + roadW;
    const laneWidth = roadW / LANE_COUNT;
    return { W, H, roadW, roadLeft, roadRight, laneWidth };
  }, []);

  const getLaneX = useCallback(
    (lane: number) => {
      const layout = getLayout();
      if (!layout) return 0;
      const { roadLeft, laneWidth } = layout;
      return roadLeft + lane * laneWidth + laneWidth / 2;
    },
    [getLayout],
  );

  // ── Obstacle spawning ────────────────────────────────────────────────────────

  const spawnObstacles = useCallback(() => {
    // y is world distance position along the road (0 = start, TOTAL_DISTANCE = finish)
    obstaclesRef.current = [
      { lane: 0, y: 200, speed: 0, hit: false },
      { lane: 2, y: 420, speed: 0, hit: false },
      { lane: 1, y: 650, speed: 0, hit: false },
    ];
  }, []);

  // ── Move player ──────────────────────────────────────────────────────────────

  const moveLeft = useCallback(() => {
    if (movingRef.current || screenRef.current !== "PLAYING") return;
    const car = carRef.current;
    if (car.lane <= 0) return;
    car.lane -= 1;
    car.targetX = getLaneX(car.lane);
    movingRef.current = true;
    setTimeout(() => {
      movingRef.current = false;
    }, MOVE_DURATION * 1000);
  }, [getLaneX]);

  const moveRight = useCallback(() => {
    if (movingRef.current || screenRef.current !== "PLAYING") return;
    const car = carRef.current;
    if (car.lane >= LANE_COUNT - 1) return;
    car.lane += 1;
    car.targetX = getLaneX(car.lane);
    movingRef.current = true;
    setTimeout(() => {
      movingRef.current = false;
    }, MOVE_DURATION * 1000);
  }, [getLaneX]);

  // ── Input handling ───────────────────────────────────────────────────────────

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") {
        e.preventDefault();
        moveLeft();
      }
      if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") {
        e.preventDefault();
        moveRight();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [moveLeft, moveRight]);

  // ── Canvas touch / tap ────────────────────────────────────────────────────────

  const handleCanvasTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    const touch = e.changedTouches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  }, []);

  const handleCanvasTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      if (!touchStartRef.current) return;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - touchStartRef.current.x;
      const dy = touch.clientY - touchStartRef.current.y;
      touchStartRef.current = null;

      // Swipe
      if (Math.abs(dx) > 20 && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) moveLeft();
        else moveRight();
        return;
      }

      // Tap: left or right half of screen
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (touch.clientX < canvas.width / 2) moveLeft();
      else moveRight();
    },
    [moveLeft, moveRight],
  );

  // ── Game loop ─────────────────────────────────────────────────────────────────

  const gameLoop = useCallback(
    (timestamp: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      if (lastTimeRef.current === null) {
        lastTimeRef.current = timestamp;
      }
      const dt = Math.min((timestamp - lastTimeRef.current) / 1000, 0.05);
      lastTimeRef.current = timestamp;

      const layout = getLayout();
      if (!layout) {
        animFrameRef.current = requestAnimationFrame(gameLoop);
        return;
      }
      const { W, H, roadLeft, roadRight, laneWidth } = layout;

      const isPlaying = screenRef.current === "PLAYING";
      const isWin = screenRef.current === "WIN";

      // ── Update game state ──────────────────────────────────────────────────

      if (isPlaying) {
        // Timer
        timerRef.current -= dt;
        if (timerRef.current < 0) timerRef.current = 0;

        // Progress
        distanceRef.current += BASE_SPEED * dt;
        roadOffsetRef.current += BASE_SPEED * dt;

        // Timer display sync (throttle)
        const newTimer = Math.ceil(timerRef.current);
        setTimerDisplay(newTimer);
        setProgressDisplay(Math.min(distanceRef.current / TOTAL_DISTANCE, 1));

        // Check lose
        if (timerRef.current <= 0 && distanceRef.current < TOTAL_DISTANCE) {
          triggerLose();
          return;
        }
      }

      // ── Car smooth movement ────────────────────────────────────────────────

      const car = carRef.current;
      if (!car.x) car.x = getLaneX(1);
      if (!car.targetX) car.targetX = car.x;

      const dx = car.targetX - car.x;
      car.x += dx * Math.min(1, dt * 12);

      // Bounce decay
      if (car.bounceY > 0) {
        car.bounceY -= dt * 120;
        if (car.bounceY < 0) car.bounceY = 0;
      }

      // Car moves upward from bottom toward finish line at top
      const finishScreenY = H * FINISH_LINE_Y_FRACTION;
      const carStartY = H * 0.82;
      const progress = Math.min(distanceRef.current / TOTAL_DISTANCE, 1);
      car.y =
        carStartY -
        progress * (carStartY - finishScreenY - car.height) +
        car.bounceY;

      // ── Obstacles ──────────────────────────────────────────────────────────

      if (isPlaying) {
        for (const obs of obstaclesRef.current) {
          // obs.y = world distance position (0=start, TOTAL_DISTANCE=finish)
          // Map to screen: same formula as car
          const obsScreenY =
            carStartY -
            (obs.y / TOTAL_DISTANCE) * (carStartY - finishScreenY - car.height);

          // Respawn when car has passed this obstacle
          if (distanceRef.current > obs.y + 60) {
            obs.y = distanceRef.current + 250 + Math.random() * 400;
            if (obs.y > TOTAL_DISTANCE - 50) obs.y = TOTAL_DISTANCE - 50;
            obs.lane = Math.floor(Math.random() * LANE_COUNT);
            obs.hit = false;
          }

          // Collision detection
          const obsX = getLaneX(obs.lane);
          const carHalfW = car.width / 2;
          const obsHalfW = 28;
          const carHalfH = car.height / 2;
          const obsHalfH = 50;

          if (
            !obs.hit &&
            Math.abs(car.x - obsX) < carHalfW + obsHalfW - 8 &&
            Math.abs(car.y - obsScreenY) < carHalfH + obsHalfH - 12
          ) {
            obs.hit = true;
            distanceRef.current = Math.max(
              0,
              distanceRef.current - OBSTACLE_BOUNCE,
            );
            car.bounceY = 15;
            setTimeout(() => {
              obs.hit = false;
            }, 300);
          }
        }
      }

      // ── Check win ──────────────────────────────────────────────────────────

      if (isPlaying && distanceRef.current >= TOTAL_DISTANCE) {
        triggerWin();
        return;
      }

      // ── Render ─────────────────────────────────────────────────────────────

      ctx.clearRect(0, 0, W, H);

      // Road
      drawRoad(
        ctx,
        canvas,
        roadOffsetRef.current,
        laneWidth,
        roadLeft,
        roadRight,
      );

      // Finish line is always fixed at top of road
      drawFinishLine(ctx, H * FINISH_LINE_Y_FRACTION, roadLeft, roadRight, 1);

      // Obstacles — screen Y based on world position (same mapping as car)
      for (const obs of obstaclesRef.current) {
        const obsScreenY =
          H * 0.82 -
          (obs.y / TOTAL_DISTANCE) *
            (H * 0.82 - H * FINISH_LINE_Y_FRACTION - carRef.current.height);
        if (obsScreenY > -80 && obsScreenY < H + 80) {
          const obsX = getLaneX(obs.lane);
          drawCar(ctx, obsX, obsScreenY, 28, 50, false);
        }
      }

      // Player car
      drawCar(ctx, car.x, car.y, car.width, car.height, true);

      // Confetti overlay (on WIN screen)
      if (isWin && confettiRef.current.length > 0) {
        updateConfetti(confettiRef.current, H);
        drawConfetti(ctx, confettiRef.current);
      }

      animFrameRef.current = requestAnimationFrame(gameLoop);
    },
    [getLayout, getLaneX],
  );

  // ── Trigger functions ─────────────────────────────────────────────────────

  const triggerWin = useCallback(() => {
    screenRef.current = "WIN";
    setScreen("WIN");

    // Record win silently
    try {
      actor?.recordWin().catch(() => {});
    } catch {
      // ignore
    }

    // Lower music
    if (audioRef.current) audioRef.current.volume = 0.3;

    // Spawn confetti
    const canvas = canvasRef.current;
    confettiRef.current = createConfetti(60, canvas?.width ?? 400);

    // Show win text after short delay
    setTimeout(() => setWinTextVisible(true), 300);
    setTimeout(() => setRewardBtnVisible(true), 2500);
  }, [actor]);

  const triggerLose = useCallback(() => {
    screenRef.current = "LOSE";
    setScreen("LOSE");
    cancelAnimationFrame(animFrameRef.current);

    // Show lose text sequentially
    setTimeout(() => setLoseText1Visible(true), 200);
    setTimeout(() => setLoseText2Visible(true), 1600);
    setTimeout(() => setLoseBtnVisible(true), 2600);
  }, []);

  // ── Start game ────────────────────────────────────────────────────────────

  const startGame = useCallback(() => {
    // Reset all state
    distanceRef.current = 0;
    timerRef.current = TIMER_SECONDS;
    roadOffsetRef.current = 0;
    lastTimeRef.current = null;
    movingRef.current = false;
    confettiRef.current = [];

    setTimerDisplay(TIMER_SECONDS);
    setProgressDisplay(0);
    setWinTextVisible(false);
    setRewardBtnVisible(false);
    setLoseText1Visible(false);
    setLoseText2Visible(false);
    setLoseBtnVisible(false);

    // Reset car to center
    const car = carRef.current;
    car.lane = 1;
    car.x = 0; // will be set in loop
    car.targetX = 0;
    car.bounceY = 0;

    spawnObstacles();

    screenRef.current = "PLAYING";
    setScreen("PLAYING");

    startAudio();

    cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = requestAnimationFrame(gameLoop);
  }, [gameLoop, spawnObstacles, startAudio]);

  const tryAgain = useCallback(() => {
    screenRef.current = "START";
    setScreen("START");
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current.volume = 0.6;
    }
    cancelAnimationFrame(animFrameRef.current);
  }, []);

  // ── Canvas resize ─────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      // Recalculate car x position
      const car = carRef.current;
      car.x = getLaneX(car.lane);
      car.targetX = car.x;
    };

    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [getLaneX]);

  // ── Draw idle frame on mount / screen change ──────────────────────────────

  useEffect(() => {
    if (screen !== "PLAYING" && screen !== "WIN") {
      cancelAnimationFrame(animFrameRef.current);
    }
  }, [screen]);

  // Draw a static road frame on start screen
  useEffect(() => {
    if (screen === "START") {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const W = canvas.width;
      const H = canvas.height;
      const roadW = Math.min(W * 0.72, 320);
      const roadLeft = (W - roadW) / 2;
      const roadRight = roadLeft + roadW;
      const laneWidth = roadW / LANE_COUNT;

      drawRoad(ctx, canvas, 0, laneWidth, roadLeft, roadRight);

      // Draw finish line at top of road
      drawFinishLine(ctx, H * FINISH_LINE_Y_FRACTION, roadLeft, roadRight, 1);

      // Draw car near bottom
      carRef.current.x = W / 2;
      carRef.current.y = H * 0.82;
      drawCar(ctx, W / 2, H * 0.82, 32, 58, true);
    }
  }, [screen]);

  // ── Cleanup ───────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  // ── Timer color ───────────────────────────────────────────────────────────

  const timerColor =
    timerDisplay <= 5 ? "#f87171" : timerDisplay <= 10 ? "#fbbf24" : GOLD;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="relative w-full h-full overflow-hidden select-none"
      style={{ background: ROAD_BG, touchAction: "none" }}
    >
      {/* Canvas — always rendered */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ touchAction: "none" }}
        onTouchStart={screen === "PLAYING" ? handleCanvasTouchStart : undefined}
        onTouchEnd={screen === "PLAYING" ? handleCanvasTouchEnd : undefined}
      />

      {/* ── START Screen ──────────────────────────────────────────────────── */}
      <AnimatePresence>
        {screen === "START" && (
          <motion.div
            key="start"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="absolute inset-0 flex flex-col items-center justify-center"
            style={{
              background:
                "linear-gradient(to bottom, rgba(13,13,18,0.85) 0%, rgba(13,13,18,0.7) 60%, rgba(13,13,18,0.92) 100%)",
            }}
          >
            {/* Road glow stripe */}
            <div
              className="absolute"
              style={{
                top: 0,
                bottom: 0,
                left: "50%",
                transform: "translateX(-50%)",
                width: "min(72vw, 320px)",
                background:
                  "linear-gradient(to bottom, transparent, rgba(94,184,245,0.04) 30%, rgba(212,168,75,0.05) 70%, transparent)",
                pointerEvents: "none",
              }}
            />

            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, duration: 0.8 }}
              className="text-center px-6 z-10"
            >
              {/* Checkered flag row */}
              <div className="flex justify-center gap-1 mb-6">
                {(["l0", "l1", "l2", "l3", "l4", "l5"] as const).map((k, i) => (
                  <div
                    key={k}
                    className="w-5 h-5"
                    style={{
                      background:
                        i % 2 === 0
                          ? "rgba(255,255,255,0.8)"
                          : "rgba(30,30,30,0.9)",
                      borderRadius: "2px",
                    }}
                  />
                ))}
                <span className="mx-2 text-xl">🏁</span>
                {(["r0", "r1", "r2", "r3", "r4", "r5"] as const).map((k, i) => (
                  <div
                    key={k}
                    className="w-5 h-5"
                    style={{
                      background:
                        i % 2 === 0
                          ? "rgba(30,30,30,0.9)"
                          : "rgba(255,255,255,0.8)",
                      borderRadius: "2px",
                    }}
                  />
                ))}
              </div>

              <h1
                className="font-playfair glow-gold mb-1"
                style={{
                  color: GOLD,
                  fontSize: "clamp(2rem, 8vw, 3.2rem)",
                  fontWeight: 700,
                  lineHeight: 1.1,
                  letterSpacing: "-0.01em",
                }}
              >
                Race to Finish
              </h1>

              <h2
                className="font-playfair glow-blue mb-3"
                style={{
                  color: BLUE_NEON,
                  fontSize: "clamp(1.4rem, 6vw, 2.2rem)",
                  fontWeight: 400,
                  fontStyle: "italic",
                  letterSpacing: "0.06em",
                }}
              >
                24 Years
              </h2>

              <p
                className="font-general mb-10"
                style={{
                  color: "rgba(240,236,224,0.5)",
                  fontSize: "clamp(0.8rem, 3vw, 1rem)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                Reach the finish line before time runs out
              </p>

              <motion.button
                onClick={startGame}
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.97 }}
                className="btn-gold pulse-glow font-general px-10 py-4 text-sm tracking-widest uppercase rounded-sm"
                style={{
                  fontSize: "0.85rem",
                  letterSpacing: "0.2em",
                }}
              >
                Tap to Start
              </motion.button>

              <p
                className="font-general mt-6"
                style={{
                  color: "rgba(240,236,224,0.3)",
                  fontSize: "0.72rem",
                  letterSpacing: "0.1em",
                }}
              >
                ← Swipe or tap sides to steer →
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── PLAYING HUD ───────────────────────────────────────────────────── */}
      <AnimatePresence>
        {screen === "PLAYING" && (
          <motion.div
            key="hud"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="absolute inset-0 pointer-events-none"
          >
            {/* Timer */}
            <div className="absolute top-5 left-0 right-0 flex justify-center">
              <div
                className="font-playfair"
                style={{
                  color: timerColor,
                  fontSize: "clamp(2.8rem, 10vw, 4.5rem)",
                  fontWeight: 700,
                  lineHeight: 1,
                  textShadow: `0 0 20px ${timerColor}80, 0 0 40px ${timerColor}40`,
                  transition: "color 0.5s ease",
                }}
              >
                {timerDisplay}
              </div>
            </div>

            {/* Progress bar */}
            <div
              className="absolute"
              style={{
                top: 16,
                left: 16,
                width: 80,
                height: 3,
                background: "rgba(255,255,255,0.1)",
                borderRadius: 2,
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${progressDisplay * 100}%`,
                  background: GOLD,
                  borderRadius: 2,
                  boxShadow: `0 0 8px ${GOLD}`,
                  transition: "width 0.1s linear",
                }}
              />
              <p
                className="font-general"
                style={{
                  color: "rgba(240,236,224,0.35)",
                  fontSize: "0.62rem",
                  marginTop: 4,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                Distance
              </p>
            </div>

            {/* Mute button */}
            <div className="absolute top-4 right-4 pointer-events-auto">
              <button
                type="button"
                onClick={() => setMuted((m) => !m)}
                className="font-general text-lg w-9 h-9 flex items-center justify-center rounded-full"
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  color: "rgba(240,236,224,0.6)",
                  transition: "all 0.2s ease",
                }}
                aria-label={muted ? "Unmute" : "Mute"}
              >
                {muted ? "🔇" : "🔊"}
              </button>
            </div>

            {/* Touch controls hint overlay (bottom) */}
            <div
              className="absolute bottom-6 left-0 right-0 flex justify-between px-6"
              style={{ pointerEvents: "auto" }}
            >
              <button
                type="button"
                onTouchStart={(e) => {
                  e.preventDefault();
                  moveLeft();
                }}
                onClick={moveLeft}
                className="font-general"
                style={{
                  color: "rgba(240,236,224,0.2)",
                  fontSize: "1.5rem",
                  background: "transparent",
                  border: "none",
                  padding: "12px 24px",
                  cursor: "pointer",
                }}
                aria-label="Move left"
              >
                ‹
              </button>
              <button
                type="button"
                onTouchStart={(e) => {
                  e.preventDefault();
                  moveRight();
                }}
                onClick={moveRight}
                className="font-general"
                style={{
                  color: "rgba(240,236,224,0.2)",
                  fontSize: "1.5rem",
                  background: "transparent",
                  border: "none",
                  padding: "12px 24px",
                  cursor: "pointer",
                }}
                aria-label="Move right"
              >
                ›
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── WIN Screen overlay ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {screen === "WIN" && (
          <motion.div
            key="win"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
            className="absolute inset-0 flex flex-col items-center justify-center"
            style={{
              background:
                "linear-gradient(to bottom, rgba(8,6,3,0.75) 0%, rgba(10,8,5,0.85) 100%)",
            }}
          >
            {/* Mute button */}
            <div className="absolute top-4 right-4">
              <button
                type="button"
                onClick={() => setMuted((m) => !m)}
                className="font-general text-lg w-9 h-9 flex items-center justify-center rounded-full"
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  color: "rgba(240,236,224,0.6)",
                }}
                aria-label={muted ? "Unmute" : "Mute"}
              >
                {muted ? "🔇" : "🔊"}
              </button>
            </div>

            <AnimatePresence>
              {winTextVisible && (
                <motion.div
                  key="wintext"
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 1.5, ease: "easeOut" }}
                  className="text-center px-8 max-w-sm"
                >
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.2, duration: 1.2 }}
                    className="font-playfair mb-3"
                    style={{
                      color: WHITE_SOFT,
                      fontSize: "clamp(1.1rem, 5vw, 1.6rem)",
                      fontStyle: "italic",
                      fontWeight: 400,
                      lineHeight: 1.4,
                    }}
                  >
                    You didn't just win this race.
                  </motion.p>

                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.9, duration: 1.2 }}
                    className="font-playfair"
                    style={{
                      color: WHITE_SOFT,
                      fontSize: "clamp(1.1rem, 5vw, 1.6rem)",
                      fontStyle: "italic",
                      fontWeight: 400,
                      lineHeight: 1.4,
                    }}
                  >
                    You've been winning my heart since day one.
                  </motion.p>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {rewardBtnVisible && (
                <motion.button
                  key="rewardbtn"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.6, ease: "easeOut" }}
                  onClick={() => setScreen("REWARD")}
                  whileHover={{ scale: 1.04 }}
                  whileTap={{ scale: 0.97 }}
                  className="btn-gold pulse-glow font-general mt-10 px-8 py-4 text-sm tracking-widest uppercase rounded-sm"
                  style={{
                    fontSize: "0.85rem",
                    letterSpacing: "0.16em",
                  }}
                >
                  🎁 Here's your reward
                </motion.button>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── REWARD Screen ─────────────────────────────────────────────────── */}
      <AnimatePresence>
        {screen === "REWARD" && (
          <motion.div
            key="reward"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6 }}
            className="absolute inset-0 flex flex-col overflow-y-auto"
            style={{
              background: `radial-gradient(ellipse at 30% 20%, rgba(94,184,245,0.06) 0%, transparent 60%),
                           radial-gradient(ellipse at 70% 80%, rgba(212,168,75,0.08) 0%, transparent 60%),
                           #0a0810`,
            }}
          >
            {/* Subtle sparkle bg */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage: `radial-gradient(1px 1px at 20% 25%, rgba(212,168,75,0.3) 0%, transparent 100%),
                                  radial-gradient(1px 1px at 70% 15%, rgba(94,184,245,0.3) 0%, transparent 100%),
                                  radial-gradient(1px 1px at 40% 75%, rgba(240,236,224,0.2) 0%, transparent 100%),
                                  radial-gradient(1px 1px at 85% 60%, rgba(212,168,75,0.25) 0%, transparent 100%)`,
              }}
            />

            <div className="flex-1 flex flex-col items-center justify-start py-14 px-6 z-10">
              {/* Decorative top */}
              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.2, duration: 0.8 }}
                className="mb-8 text-center"
              >
                <div
                  className="font-general mb-3"
                  style={{ fontSize: "2rem", lineHeight: 1 }}
                >
                  🤍
                </div>
                <div
                  style={{
                    width: 60,
                    height: 1,
                    background: `linear-gradient(to right, transparent, ${GOLD}, transparent)`,
                    margin: "0 auto",
                  }}
                />
              </motion.div>

              {/* Message */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4, duration: 1 }}
                className="max-w-[380px] w-full text-center"
              >
                <p
                  className="font-playfair"
                  style={{
                    color: WHITE_SOFT,
                    fontSize: "clamp(0.95rem, 3.5vw, 1.15rem)",
                    lineHeight: 1.9,
                    fontWeight: 400,
                    whiteSpace: "pre-line",
                  }}
                >
                  {`From a college boy decorating a hostel room with fairy lights for me…
To a man building a home for us…
I've watched you grow in the most beautiful way.`}
                </p>

                <div
                  style={{
                    width: 40,
                    height: 1,
                    background:
                      "linear-gradient(to right, transparent, rgba(212,168,75,0.4), transparent)",
                    margin: "1.8rem auto",
                  }}
                />

                <p
                  className="font-playfair"
                  style={{
                    color: WHITE_SOFT,
                    fontSize: "clamp(0.95rem, 3.5vw, 1.15rem)",
                    lineHeight: 1.9,
                    fontWeight: 400,
                    whiteSpace: "pre-line",
                  }}
                >
                  {`Mera Kadduji. Meraa pyaari Kadduji. Mera Handsome Kadduji.
Mera gussa karne wala Kadduji. Mera sad Kadduji.
Mera khikhikhi hasne wala Kadduji.`}
                </p>

                <div
                  style={{
                    width: 40,
                    height: 1,
                    background:
                      "linear-gradient(to right, transparent, rgba(212,168,75,0.4), transparent)",
                    margin: "1.8rem auto",
                  }}
                />

                <p
                  className="font-playfair"
                  style={{
                    color: WHITE_SOFT,
                    fontSize: "clamp(0.95rem, 3.5vw, 1.15rem)",
                    lineHeight: 2,
                    fontWeight: 400,
                  }}
                >
                  I love you in every way you exist.
                  <br />I choose you in every phase.
                  <br />
                  I'm proud of you.
                </p>

                <div
                  style={{
                    width: 40,
                    height: 1,
                    background:
                      "linear-gradient(to right, transparent, rgba(212,168,75,0.4), transparent)",
                    margin: "1.8rem auto",
                  }}
                />

                <p
                  className="font-playfair"
                  style={{
                    color: WHITE_SOFT,
                    fontSize: "clamp(0.95rem, 3.5vw, 1.15rem)",
                    lineHeight: 1.9,
                    fontWeight: 400,
                    whiteSpace: "pre-line",
                  }}
                >
                  {`InshaAllah, next 27th March, you won't be opening gifts on a video call because…
I'll be right beside you.`}
                </p>

                <p
                  className="font-playfair mt-5"
                  style={{
                    color: GOLD,
                    fontSize: "clamp(1rem, 4vw, 1.3rem)",
                    fontWeight: 700,
                    letterSpacing: "0.12em",
                    textShadow: `0 0 16px ${GOLD}70`,
                  }}
                >
                  AS YOUR WIFE.
                </p>
              </motion.div>

              {/* Divider */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 1, duration: 1 }}
                className="mt-10 mb-6 text-center"
              >
                <div
                  style={{
                    width: 80,
                    height: 1,
                    background: `linear-gradient(to right, transparent, ${GOLD}60, transparent)`,
                    margin: "0 auto 1.5rem",
                  }}
                />
                <p
                  className="font-general"
                  style={{
                    color: "rgba(240,236,224,0.35)",
                    fontSize: "0.78rem",
                    letterSpacing: "0.06em",
                  }}
                >
                  Built with love by YOURs Juveria 🤍
                </p>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── LOSE Screen ──────────────────────────────────────────────────── */}
      <AnimatePresence>
        {screen === "LOSE" && (
          <motion.div
            key="lose"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6 }}
            className="absolute inset-0 flex flex-col items-center justify-center"
            style={{
              background:
                "linear-gradient(to bottom, rgba(8,6,3,0.88) 0%, rgba(12,9,6,0.92) 100%)",
            }}
          >
            <div className="text-center px-8 max-w-sm">
              <AnimatePresence>
                {loseText1Visible && (
                  <motion.p
                    key="lose1"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.8 }}
                    className="font-playfair mb-4"
                    style={{
                      color: "rgba(240,236,224,0.6)",
                      fontSize: "clamp(1.2rem, 5vw, 1.8rem)",
                      fontStyle: "italic",
                      fontWeight: 400,
                    }}
                  >
                    Time's up.
                  </motion.p>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {loseText2Visible && (
                  <motion.p
                    key="lose2"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.8 }}
                    className="font-playfair mb-10"
                    style={{
                      color: WHITE_SOFT,
                      fontSize: "clamp(1.1rem, 4.5vw, 1.5rem)",
                      fontStyle: "italic",
                      fontWeight: 400,
                      lineHeight: 1.5,
                    }}
                  >
                    But don't worry… you still win with me.
                  </motion.p>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {loseBtnVisible && (
                  <motion.button
                    key="losebtn"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.5 }}
                    onClick={tryAgain}
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.97 }}
                    className="btn-gold font-general px-8 py-3 text-sm tracking-widest uppercase rounded-sm"
                    style={{
                      fontSize: "0.82rem",
                      letterSpacing: "0.2em",
                    }}
                  >
                    Try Again
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default RacingGame;
