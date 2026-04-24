(function () {
  'use strict';

  const {
    Engine,
    Render,
    Runner,
    Bodies,
    Body,
    Composite,
    Events,
    Mouse,
    MouseConstraint,
  } = Matter;

  const MAX_BODIES = 130;
  const MAX_CONCURRENT_VIDEOS = 4;
  const HEART_INTERVAL_MS = 240;
  const PHOTO_INTERVAL_MS = 3200;
  const VIDEO_SPAWN_INTERVAL_MS = 4500;
  const SPAWN_BURST_MIN = 1;
  const SPAWN_BURST_MAX = 2;
  const IDLE_SPEED = 0.18;
  const IDLE_ANG = 0.012;

  /** Photos/videos removed after this long in the low zone (no floor touch). */
  const PHOTO_VIDEO_MS_IN_LOW_ZONE_BEFORE_REMOVE = 6000;
  /** Hearts removed a bit sooner so fewer pile near the bottom (ms in low zone). */
  const HEART_MS_IN_LOW_ZONE_BEFORE_REMOVE = 3400;
  /** When body center is below (this × height), photo/video low-zone timer runs. */
  const REMOVE_ZONE_START_FRAC = 0.58;
  /** Hearts use a slightly higher line so they fade before the bottom feels crowded. */
  const HEART_LOW_ZONE_START_FRAC = 0.52;

  const host = document.getElementById('canvas-host');

  let width = window.innerWidth;
  let height = window.innerHeight;

  let imagePaths = [];
  let videoPaths = [];

  const engine = Engine.create({ enableSleeping: false });
  engine.world.gravity.y = 0.68;
  engine.world.gravity.scale = 0.001;
  const world = engine.world;

  function worldHasBody(body) {
    return Composite.allBodies(world).indexOf(body) !== -1;
  }

  function randomBurstCount() {
    return SPAWN_BURST_MIN + Math.floor(Math.random() * (SPAWN_BURST_MAX - SPAWN_BURST_MIN + 1));
  }

  const render = Render.create({
    element: host,
    engine,
    options: {
      width,
      height,
      wireframes: false,
      background: 'transparent',
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    },
  });

  const runner = Runner.create();
  Runner.run(runner, engine);
  Render.run(render);

  let floor;
  let wallLeft;
  let wallRight;

  function wallOptions() {
    return {
      isStatic: true,
      friction: 0.45,
      restitution: 0.35,
      render: { fillStyle: 'transparent', strokeStyle: 'transparent', lineWidth: 0 },
    };
  }

  function rebuildWalls() {
    if (floor) Composite.remove(world, floor);
    if (wallLeft) Composite.remove(world, wallLeft);
    if (wallRight) Composite.remove(world, wallRight);

    const t = 80;
    floor = Bodies.rectangle(width / 2, height + t / 2 - 4, width * 2, t, wallOptions());
    wallLeft = Bodies.rectangle(-t / 2 + 2, height / 2, t, height * 3, wallOptions());
    wallRight = Bodies.rectangle(width + t / 2 - 2, height / 2, t, height * 3, wallOptions());
    Composite.add(world, [floor, wallLeft, wallRight]);
  }

  rebuildWalls();

  const defaultBodyRender = {
    strokeStyle: 'rgba(255, 200, 220, 0.35)',
    lineWidth: 1,
  };

  const mouse = Mouse.create(render.canvas);
  const mouseConstraint = MouseConstraint.create(engine, {
    mouse,
    constraint: {
      stiffness: 0.14,
      damping: 0.09,
      render: { visible: false },
    },
  });
  Composite.add(world, mouseConstraint);
  render.mouse = mouse;
  mouse.pixelRatio = render.options.pixelRatio;

  const videoRegistry = new Map();

  function cleanupVideoBody(body) {
    const s = videoRegistry.get(body);
    if (!s) return;
    try {
      s.video.pause();
    } catch (e) {
      /* ignore */
    }
    s.video.remove();
    videoRegistry.delete(body);
  }

  function removeDynamicBody(body) {
    if (body.label === 'video') cleanupVideoBody(body);
    Composite.remove(world, body);
  }

  function trimExcessBodies() {
    let dynamics = Composite.allBodies(world).filter((b) => !b.isStatic);
    if (dynamics.length <= MAX_BODIES) return;

    function trimPhase(filterFn) {
      dynamics = Composite.allBodies(world).filter((b) => !b.isStatic);
      if (dynamics.length <= MAX_BODIES) return true;
      let remove = dynamics.length - MAX_BODIES;
      const batch = dynamics.filter(filterFn).sort((a, b) => a.id - b.id);
      for (const b of batch) {
        if (remove <= 0) break;
        removeDynamicBody(b);
        remove--;
      }
      return Composite.allBodies(world).filter((b) => !b.isStatic).length <= MAX_BODIES;
    }

    if (trimPhase((b) => b.label === 'heart')) return;
    if (trimPhase((b) => b.label === 'photo')) return;
    trimPhase((b) => b.label === 'video');
  }

  function spawnHeart() {
    const r = 8 + Math.random() * 14;
    const x = r + Math.random() * (width - r * 2);
    const y = -20 - Math.random() * 40;

    const body = Bodies.circle(x, y, r, {
      label: 'heart',
      frictionAir: 0.012,
      friction: 0.08,
      restitution: 0.52,
      density: 0.0012,
      angle: (Math.random() - 0.5) * 0.4,
      angularVelocity: (Math.random() - 0.5) * 0.04,
      collisionFilter: { category: 0x0002, mask: 0xffff },
      render: {
        ...defaultBodyRender,
        visible: false,
      },
    });
    body.customRadius = r;
    Composite.add(world, body);
    trimExcessBodies();
  }

  function spawnPhotoPlaceholder() {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 200;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, c.width, c.height);
    grd.addColorStop(0, '#ff9ec5');
    grd.addColorStop(1, '#d63a5c');
    g.fillStyle = grd;
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(255, 255, 255, 0.85)';
    g.font = 'italic 22px Georgia';
    g.textAlign = 'center';
    g.fillText('Memory', c.width / 2, c.height / 2 + 8);
    spawnPhoto(c, c.width, c.height);
  }

  function sanitizeMediaPaths(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim();
        return '';
      })
      .filter((u) => u.length > 0 && !u.startsWith('[object'));
  }

  function spawnPhotoFromUrl(url) {
    if (typeof url !== 'string' || !url) {
      spawnPhotoPlaceholder();
      return;
    }
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth < 2 || img.naturalHeight < 2) {
        spawnPhotoPlaceholder();
        return;
      }
      const useCanvasTexture = () => {
        try {
          const tex = document.createElement('canvas');
          tex.width = img.naturalWidth;
          tex.height = img.naturalHeight;
          const gx = tex.getContext('2d');
          gx.drawImage(img, 0, 0);
          spawnPhoto(tex, tex.width, tex.height);
        } catch (e) {
          spawnPhotoPlaceholder();
        }
      };
      if (typeof img.decode === 'function') {
        img.decode().then(useCanvasTexture).catch(() => spawnPhotoPlaceholder());
      } else {
        useCanvasTexture();
      }
    };
    img.onerror = () => spawnPhotoPlaceholder();
    img.src = url;
  }

  const PHOTO_CORNER_RADIUS = 14;

  function getPhotoLayoutForViewport() {
    if (width <= 480) {
      return { maxW: Math.min(102, width * 0.3), maxH: 130, chamfer: 8 };
    }
    if (width <= 768) {
      return { maxW: Math.min(150, width * 0.34), maxH: 195, chamfer: 11 };
    }
    return { maxW: Math.min(200, width * 0.34), maxH: 260, chamfer: PHOTO_CORNER_RADIUS };
  }

  function getVideoMaxLogicalWidth() {
    if (width <= 480) return Math.min(118, width * 0.34);
    if (width <= 768) return Math.min(168, width * 0.34);
    return Math.min(196, width * 0.3);
  }

  /** Outer frame for falling video tiles (object-fit: contain inside this box). */
  function getVideoFrameBox() {
    const fw = getVideoMaxLogicalWidth();
    const fh = Math.min(Math.round(height * 0.3), Math.round(fw * 1.1));
    return { fw, fh: Math.max(Math.round(fw * 0.5), fh) };
  }

  function drawVideoFrameToCanvas(state) {
    const { video, canvas, vCtx, src } = state;
    if (!vCtx || canvas.width < 2 || canvas.height < 2) return;
    const cw = canvas.width;
    const ch = canvas.height;
    const vlabel = typeof src === 'string' ? src.split('/').pop() : 'Video';
    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    try {
      if (video.readyState >= 2 && !video.error && vw > 0 && vh > 0) {
        vCtx.fillStyle = 'rgb(12, 5, 10)';
        vCtx.fillRect(0, 0, cw, ch);
        const scale = Math.min(cw / vw, ch / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        const dx = (cw - dw) * 0.5;
        const dy = (ch - dh) * 0.5;
        vCtx.drawImage(video, 0, 0, vw, vh, dx, dy, dw, dh);
      } else {
        drawVideoPlaceholder(vCtx, cw, ch, vlabel);
      }
    } catch (e) {
      drawVideoPlaceholder(vCtx, cw, ch, vlabel);
    }
  }

  function pathRoundedRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawPhotoBody(ctx, b) {
    const tex = b._photoTex;
    if (!(tex instanceof HTMLCanvasElement) || tex.width < 2 || tex.height < 2) return;
    const bw = b.bounds.max.x - b.bounds.min.x;
    const bh = b.bounds.max.y - b.bounds.min.y;
    if (bw < 1 || bh < 1) return;
    const { x, y } = b.position;
    const hw = bw / 2;
    const hh = bh / 2;
    const cornerR = typeof b._photoCornerR === 'number' ? b._photoCornerR : PHOTO_CORNER_RADIUS;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(b.angle);
    pathRoundedRect(ctx, -hw, -hh, bw, bh, cornerR);
    ctx.clip();
    try {
      ctx.drawImage(tex, -hw, -hh, bw, bh);
    } catch (e) {
      /* skip broken bitmap */
    }
    ctx.restore();
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(b.angle);
    ctx.shadowColor = 'rgba(255, 160, 180, 0.4)';
    ctx.shadowBlur = 10;
    pathRoundedRect(ctx, -hw, -hh, bw, bh, cornerR);
    ctx.strokeStyle = 'rgba(255, 230, 240, 0.55)';
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.restore();
  }

  function drawVideoBodySprite(ctx, b, tex) {
    if (!(tex instanceof HTMLCanvasElement) || tex.width < 2 || tex.height < 2) return;
    const bw = b.bounds.max.x - b.bounds.min.x;
    const bh = b.bounds.max.y - b.bounds.min.y;
    if (bw < 1 || bh < 1) return;
    const { x, y } = b.position;
    const hw = bw / 2;
    const hh = bh / 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(b.angle);
    pathRoundedRect(ctx, -hw, -hh, bw, bh, 12);
    ctx.clip();
    try {
      ctx.drawImage(tex, -hw, -hh, bw, bh);
    } catch (e) {
      /* skip */
    }
    ctx.restore();
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(b.angle);
    ctx.shadowColor = 'rgba(255, 160, 180, 0.35)';
    ctx.shadowBlur = 8;
    pathRoundedRect(ctx, -hw, -hh, bw, bh, 12);
    ctx.strokeStyle = 'rgba(255, 220, 235, 0.45)';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.restore();
  }

  function spawnPhoto(texture, tw, th) {
    if (!(texture instanceof HTMLCanvasElement) || texture.width < 2 || texture.height < 2) {
      spawnPhotoPlaceholder();
      return;
    }

    const lim = getPhotoLayoutForViewport();
    let w = lim.maxW;
    const aspect = tw / th;
    let h = w / aspect;
    if (h > lim.maxH) {
      h = lim.maxH;
      w = h * aspect;
    }

    const x = w / 2 + Math.random() * Math.max(1, width - w);
    const y = -h - 140 - Math.random() * 220;

    const body = Bodies.rectangle(x, y, w, h, {
      label: 'photo',
      frictionAir: 0.034,
      friction: 0.38,
      restitution: 0.34,
      density: 0.00072,
      chamfer: { radius: lim.chamfer },
      angle: (Math.random() - 0.5) * 0.35,
      angularVelocity: (Math.random() - 0.5) * 0.016,
      collisionFilter: { category: 0x0004, mask: 0xffff },
      render: {
        visible: false,
        fillStyle: 'transparent',
        strokeStyle: 'transparent',
        lineWidth: 0,
      },
    });
    body._photoTex = texture;
    body._photoCornerR = lim.chamfer;
    Composite.add(world, body);
    trimExcessBodies();
  }

  function drawVideoPlaceholder(ctx, cw, ch, label) {
    ctx.fillStyle = 'rgba(80, 20, 45, 0.92)';
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = 'rgba(255, 200, 220, 0.75)';
    ctx.font = '13px Georgia';
    ctx.textAlign = 'center';
    ctx.fillText(label || 'Video', cw / 2, ch / 2 + 4);
  }

  function spawnVideoPhysics(src) {
    if (typeof src !== 'string' || !src.trim()) return;
    const video = document.createElement('video');
    video.className = 'video-source';
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.loop = true;
    video.preload = 'auto';
    video.src = src;
    document.body.appendChild(video);

    const canvas = document.createElement('canvas');
    const vCtx = canvas.getContext('2d');

    const box0 = getVideoFrameBox();
    const state = {
      video,
      canvas,
      vCtx,
      body: null,
      logicalW: box0.fw,
      logicalH: box0.fh,
      src,
    };

    function layoutFromVideo() {
      const { fw, fh } = getVideoFrameBox();
      state.logicalW = fw;
      state.logicalH = fh;
      const px = Math.min(640 / fw, 640 / fh, 2.5);
      canvas.width = Math.max(2, Math.floor(fw * px));
      canvas.height = Math.max(2, Math.floor(fh * px));
    }

    function drawFrame() {
      drawVideoFrameToCanvas(state);
    }

    function attachBody() {
      if (state.body) return;
      layoutFromVideo();
      drawFrame();

      const x = state.logicalW / 2 + Math.random() * Math.max(1, width - state.logicalW);
      const y = -state.logicalH - 120 - Math.random() * 200;

      const body = Bodies.rectangle(x, y, state.logicalW, state.logicalH, {
        label: 'video',
        frictionAir: 0.036,
        friction: 0.42,
        restitution: 0.3,
        density: 0.00072,
        chamfer: { radius: 12 },
        angle: (Math.random() - 0.5) * 0.28,
        angularVelocity: (Math.random() - 0.5) * 0.014,
        collisionFilter: { category: 0x0008, mask: 0xffff },
        render: {
          visible: false,
          fillStyle: 'transparent',
          strokeStyle: 'transparent',
          lineWidth: 0,
        },
      });
      state.body = body;
      videoRegistry.set(body, state);
      Composite.add(world, body);
      trimExcessBodies();
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }

    video.addEventListener('loadedmetadata', () => {
      layoutFromVideo();
      if (!state.body) {
        attachBody();
      } else {
        const b = state.body;
        const bw = b.bounds.max.x - b.bounds.min.x;
        const bh = b.bounds.max.y - b.bounds.min.y;
        if (bw > 0.001 && bh > 0.001) {
          Body.scale(b, state.logicalW / bw, state.logicalH / bh);
        }
      }
    });

    video.addEventListener('error', () => {
      if (!state.body) {
        layoutFromVideo();
        drawVideoPlaceholder(vCtx, canvas.width, canvas.height, 'Clip unavailable');
        attachBody();
      }
    });

    video.addEventListener('canplay', () => {
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    });

    setTimeout(() => {
      if (!state.body) {
        layoutFromVideo();
        drawVideoPlaceholder(
          vCtx,
          canvas.width,
          canvas.height,
          typeof state.src === 'string' ? state.src.split('/').pop() : 'Video'
        );
        attachBody();
      }
    }, 2000);
  }

  function drawHeartPath(ctx, cx, cy, scale) {
    ctx.beginPath();
    const s = scale / 16;
    ctx.moveTo(cx, cy + 5 * s);
    ctx.bezierCurveTo(cx, cy, cx - 9 * s, cy - 8 * s, cx - 9 * s, cy - 3 * s);
    ctx.bezierCurveTo(cx - 9 * s, cy + 3 * s, cx, cy + 8 * s, cx, cy + 12 * s);
    ctx.bezierCurveTo(cx, cy + 8 * s, cx + 9 * s, cy + 3 * s, cx + 9 * s, cy - 3 * s);
    ctx.bezierCurveTo(cx + 9 * s, cy - 8 * s, cx, cy, cx, cy + 5 * s);
    ctx.closePath();
  }

  Events.on(render, 'afterRender', () => {
    const ctx = render.context;
    const bodies = Composite.allBodies(world);

    for (const b of bodies) {
      if (b.label === 'photo') drawPhotoBody(ctx, b);
    }
    for (const [vb, state] of Array.from(videoRegistry.entries())) {
      if (worldHasBody(vb)) drawVideoBodySprite(ctx, vb, state.canvas);
    }
    for (const b of bodies) {
      if (b.label !== 'heart') continue;
      const r = b.customRadius || b.circleRadius;
      const { x, y } = b.position;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(b.angle);
      const grad = ctx.createRadialGradient(0, -r * 0.2, 0, 0, 0, r * 1.35);
      grad.addColorStop(0, '#ffb6c9');
      grad.addColorStop(0.45, '#ff4d6d');
      grad.addColorStop(1, '#c9183a');
      drawHeartPath(ctx, 0, -r * 0.25, r);
      ctx.fillStyle = grad;
      ctx.shadowColor = 'rgba(255, 120, 160, 0.85)';
      ctx.shadowBlur = r * 0.55;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(255, 240, 245, 0.45)';
      ctx.stroke();
      ctx.restore();
    }
  });

  Events.on(engine, 'beforeUpdate', () => {
    const t = engine.timing.timestamp;
    const dynamics = Composite.allBodies(world).filter((b) => !b.isStatic);

    for (const b of dynamics) {
      const speed = Math.hypot(b.velocity.x, b.velocity.y);
      const ang = Math.abs(b.angularVelocity);
      if (speed < IDLE_SPEED && ang < IDLE_ANG) {
        const phase = b.id * 0.31;
        Body.applyForce(b, b.position, {
          x: Math.sin(t * 0.0018 + phase) * 0.000045,
          y: Math.cos(t * 0.0014 + phase) * 0.000032,
        });
      }
    }

    for (const [body, state] of videoRegistry) {
      if (!worldHasBody(body)) {
        cleanupVideoBody(body);
        continue;
      }
      if (!state.vCtx || !state.canvas.width) continue;
      drawVideoFrameToCanvas(state);
    }
  });

  let lastHeart = performance.now();
  let lastPhoto = performance.now();
  let lastVideoSpawn = performance.now();

  Events.on(engine, 'afterUpdate', () => {
    const now = performance.now();
    if (now - lastHeart > HEART_INTERVAL_MS) {
      lastHeart = now;
      spawnHeart();
    }

    if (imagePaths.length && now - lastPhoto > PHOTO_INTERVAL_MS) {
      lastPhoto = now;
      const nPhotos = randomBurstCount();
      for (let i = 0; i < nPhotos; i++) {
        const path = imagePaths[(Math.random() * imagePaths.length) | 0];
        spawnPhotoFromUrl(path);
      }
    }

    const videoCount = Composite.allBodies(world).filter((b) => b.label === 'video').length;
    if (
      videoPaths.length &&
      videoCount < MAX_CONCURRENT_VIDEOS &&
      now - lastVideoSpawn > VIDEO_SPAWN_INTERVAL_MS
    ) {
      lastVideoSpawn = now;
      let nVideos = randomBurstCount();
      nVideos = Math.min(nVideos, MAX_CONCURRENT_VIDEOS - videoCount);
      for (let i = 0; i < nVideos; i++) {
        const raw = videoPaths[(Math.random() * videoPaths.length) | 0];
        if (typeof raw === 'string' && raw.trim()) spawnVideoPhysics(raw.trim());
      }
    }

    const lowLineMedia = height * REMOVE_ZONE_START_FRAC;
    const lowLineHeart = height * HEART_LOW_ZONE_START_FRAC;
    const draggedBody = mouseConstraint.body;

    const cullBodies = Composite.allBodies(world).filter(
      (b) =>
        !b.isStatic && (b.label === 'heart' || b.label === 'photo' || b.label === 'video')
    );
    for (const b of cullBodies) {
      if (b === draggedBody) {
        b._lowZoneSince = null;
        continue;
      }
      const isHeart = b.label === 'heart';
      const lineY = isHeart ? lowLineHeart : lowLineMedia;
      const waitMs = isHeart ? HEART_MS_IN_LOW_ZONE_BEFORE_REMOVE : PHOTO_VIDEO_MS_IN_LOW_ZONE_BEFORE_REMOVE;
      const inLowZone = b.position.y >= lineY;

      if (inLowZone) {
        if (b._lowZoneSince == null) b._lowZoneSince = now;
        if (now - b._lowZoneSince >= waitMs) {
          removeDynamicBody(b);
        }
      } else {
        b._lowZoneSince = null;
      }
    }
  });

  function onResize() {
    width = window.innerWidth;
    height = window.innerHeight;
    render.bounds.max.x = width;
    render.bounds.max.y = height;
    render.options.width = width;
    render.options.height = height;
    render.canvas.width = width * render.options.pixelRatio;
    render.canvas.height = height * render.options.pixelRatio;
    render.canvas.style.width = `${width}px`;
    render.canvas.style.height = `${height}px`;
    Render.setPixelRatio(render, render.options.pixelRatio);
    rebuildWalls();
    mouse.pixelRatio = render.options.pixelRatio;
  }

  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(onResize);
  });

  async function headOk(url) {
    if (typeof url !== 'string' || !url.trim()) return false;
    try {
      const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      return r.ok;
    } catch (e) {
      return false;
    }
  }

  async function discoverImagesSequential() {
    const checks = [];
    for (let i = 1; i <= 30; i++) {
      const url = `images/${i}.jpg`;
      checks.push(headOk(url).then((ok) => (ok ? url : null)));
    }
    const found = await Promise.all(checks);
    return found.filter(Boolean);
  }

  async function discoverVideosSequential() {
    const checks = [];
    for (let i = 1; i <= 20; i++) {
      const url = `videos/${i}.mp4`;
      checks.push(headOk(url).then((ok) => (ok ? url : null)));
    }
    const found = await Promise.all(checks);
    return found.filter(Boolean);
  }

  async function loadMediaLists() {
    let imagesFromManifest = false;
    let videosFromManifest = false;

    try {
      const res = await fetch('media-manifest.json', { cache: 'no-store' });
      if (res.ok) {
        const j = await res.json();
        if (j && 'images' in j && Array.isArray(j.images)) {
          imagesFromManifest = true;
          imagePaths = sanitizeMediaPaths(j.images);
        }
        if (j && 'videos' in j && Array.isArray(j.videos)) {
          videosFromManifest = true;
          videoPaths = sanitizeMediaPaths(j.videos);
        }
      }
    } catch (e) {
      /* use discovery */
    }

    if (!imagesFromManifest && !imagePaths.length) {
      imagePaths = await discoverImagesSequential();
    }

    if (!videosFromManifest) {
      if (!videoPaths.length) {
        videoPaths = await discoverVideosSequential();
      }
      if (!videoPaths.length) {
        const named = ['videos/love.mp4', 'video/love.mp4'];
        for (const u of named) {
          if (await headOk(u)) {
            videoPaths = [u];
            break;
          }
        }
      }
    }
  }

  function preloadFirstPhoto() {
    if (!imagePaths.length) return;
    spawnPhotoFromUrl(imagePaths[0]);
  }

  function bootVideos() {
    if (!videoPaths.length) return;
    spawnVideoPhysics(videoPaths[0]);
    lastVideoSpawn = performance.now();
  }

  document.addEventListener(
    'visibilitychange',
    () => {
      if (!document.hidden) {
        for (const [, s] of videoRegistry) {
          const p = s.video.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      }
    },
    false
  );

  document.body.addEventListener(
    'click',
    () => {
      for (const [, s] of videoRegistry) {
        const p = s.video.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    },
    { once: true }
  );

  for (let i = 0; i < 7; i++) spawnHeart();

  loadMediaLists().then(() => {
    preloadFirstPhoto();
    bootVideos();
  });

  (function initDragHint() {
    const hint = document.getElementById('drag-hint');
    if (!hint) return;
    let dismissed = false;
    function dismissHintOnce() {
      if (dismissed) return;
      dismissed = true;
      hint.classList.add('drag-hint--gone');
    }
    Events.on(mouseConstraint, 'startdrag', dismissHintOnce);
  })();
})();
