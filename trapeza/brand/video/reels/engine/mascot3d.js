/* 3D-маскот Первички — синий «документ» с загнутым уголком, глазами-капсулами и ножками.
 * Без моделей и внешних сервисов: вся геометрия собирается из примитивов three.js 0.170.
 *
 *   const ST = makeStage(canvas, { flat: true, dist: 15 });
 *   const P = ST.add();          // поза — обычный объект, его анимирует GSAP
 *   ST.render();                 // в onUpdate таймлайна
 *   ST.at(px, py), ST.ppu        // перевод экранных пикселей в сцену; рост при s=1 — 4.4 * ppu
 *   ST.pointOf(P, поза, 'tip')   // где на экране окажется часть: tip, shield, head, bulb, eye
 *
 * Первая версия пропала вместе с контейнером; эта собрана заново по записанному
 * интерфейсу, поэтому шаблоны роликов подключают её без правок. */
(function () {
  const T3 = window.THREE;
  const W = 1080, H = 1920;

  const plastic = (color, o = {}) => new T3.MeshStandardMaterial(Object.assign({ color, roughness: 0.38, metalness: 0.05 }, o));
  const glow = (color) => new T3.MeshBasicMaterial({ color });

  function glowTexture(inner, outer) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, inner); gr.addColorStop(0.45, outer); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const t = new T3.CanvasTexture(c); t.colorSpace = T3.SRGBColorSpace; return t;
  }
  function plaidTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'); g.fillStyle = '#8a5a35'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = 'rgba(60,35,20,.55)'; for (let i = 0; i < 64; i += 16) { g.fillRect(i, 0, 6, 64); g.fillRect(0, i, 64, 6); }
    g.fillStyle = 'rgba(230,190,120,.35)'; for (let i = 8; i < 64; i += 16) { g.fillRect(i, 0, 2, 64); g.fillRect(0, i, 64, 2); }
    const t = new T3.CanvasTexture(c); t.wrapS = t.wrapT = T3.RepeatWrapping; t.repeat.set(3, 3); t.colorSpace = T3.SRGBColorSpace; return t;
  }
  function sprite(tex, size, opacity = 1) {
    const s = new T3.Sprite(new T3.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity, blending: T3.AdditiveBlending }));
    s.scale.set(size, size, 1); return s;
  }
  // Часть костюма появляется «пружинкой» через масштаб, а не через прозрачность: так видно, что вещь надели
  function pop(o, v) { const b = o.userData.base || 1; o.visible = v > 0.01; o.scale.setScalar(Math.max(0.0001, v) * b); }
  function base(o, k = 1) { o.userData.base = k; o.scale.setScalar(k); return o; }

  function buildCharacter() {
    const root = new T3.Group();
    const squash = new T3.Group(); root.add(squash);
    const BW = 2.5, BH = 3.1, BD = 0.55, LEG = 0.62;
    const body = new T3.Group(); body.position.y = LEG + BH / 2; squash.add(body);

    // корпус-лист со срезанным правым верхним углом
    const C = 0.62, R = 0.22, sh = new T3.Shape(), x0 = -BW / 2, x1 = BW / 2, y0 = -BH / 2, y1 = BH / 2;
    sh.moveTo(x0 + R, y0); sh.lineTo(x1 - R, y0); sh.quadraticCurveTo(x1, y0, x1, y0 + R);
    sh.lineTo(x1, y1 - C); sh.lineTo(x1 - C, y1); sh.lineTo(x0 + R, y1); sh.quadraticCurveTo(x0, y1, x0, y1 - R);
    sh.lineTo(x0, y0 + R); sh.quadraticCurveTo(x0, y0, x0 + R, y0);
    const bodyGeo = new T3.ExtrudeGeometry(sh, { depth: BD, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelSegments: 6, curveSegments: 12 });
    bodyGeo.translate(0, 0, -BD / 2);
    body.add(new T3.Mesh(bodyGeo, plastic(0x2f5fe6)));
    // загнутый уголок — светлее корпуса
    const fold = new T3.Shape(); fold.moveTo(x1 - C, y1); fold.lineTo(x1 - C, y1 - C); fold.lineTo(x1, y1 - C); fold.lineTo(x1 - C, y1);
    const foldGeo = new T3.ExtrudeGeometry(fold, { depth: 0.08, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2 });
    const foldM = new T3.Mesh(foldGeo, plastic(0x9db6ff)); foldM.position.z = BD / 2 + 0.1; body.add(foldM);

    const FZ = BD / 2 + 0.14;                                  // лицевая плоскость
    const eyes = [-0.4, 0.4].map((x) => {
      const e = new T3.Mesh(new T3.CapsuleGeometry(0.17, 0.34, 6, 16), glow(0xffffff));
      e.position.set(x, 0.38, FZ); body.add(e);
      const h = sprite(glowTexture('rgba(200,230,255,.9)', 'rgba(120,170,255,.25)'), 1.1, 0.55); h.position.set(x, 0.38, FZ + 0.02); body.add(h);
      return e;
    });
    const mouth = new T3.Mesh(new T3.SphereGeometry(0.09, 16, 12), glow(0x0d1a4a)); mouth.position.set(0, -0.12, FZ); body.add(mouth);
    [[-0.5, 0.9], [-0.78, 0.55]].forEach(([y, w]) => {
      const l = new T3.Mesh(new T3.CapsuleGeometry(0.045, w, 4, 8), glow(0xdfe8ff)); l.rotation.z = Math.PI / 2; l.position.set(-0.1, y, FZ); body.add(l);
    });

    // руки: плечо → капсула → белая перчатка
    function arm(side) {
      const sh = new T3.Group(); sh.position.set(side * (BW / 2 + 0.08), 0.05, 0); body.add(sh);
      const a = new T3.Mesh(new T3.CapsuleGeometry(0.1, 0.62, 4, 10), plastic(0x2a52c4)); a.position.y = -0.42; sh.add(a);
      const hand = new T3.Group(); hand.position.y = -0.86; sh.add(hand);
      const glove = new T3.Mesh(new T3.SphereGeometry(0.2, 20, 14), plastic(0xf4f4f6, { roughness: 0.5 })); glove.scale.set(1, 0.9, 0.9); hand.add(glove);
      return { sh, hand };
    }
    const aL = arm(-1), aR = arm(1);

    // карандаш в правой руке; кончик — точка для «волшебных искр»
    const pencil = new T3.Group(); pencil.position.set(0.05, -0.1, 0.16); pencil.rotation.z = -0.5; aR.hand.add(pencil);
    const pBody = new T3.Mesh(new T3.CylinderGeometry(0.06, 0.06, 0.8, 6), plastic(0xf2b84b)); pBody.position.y = -0.2; pencil.add(pBody);
    const pCone = new T3.Mesh(new T3.ConeGeometry(0.06, 0.18, 6), plastic(0xf3dcb4)); pCone.position.y = -0.69; pCone.rotation.x = Math.PI; pencil.add(pCone);
    const lead = new T3.Object3D(); lead.position.y = -0.8; pencil.add(lead);
    base(pencil);

    const top = new T3.Group(); top.position.y = BH / 2; body.add(top);
    // берет с усиком-звёздочкой
    const beret = new T3.Group(); top.add(beret);
    const bm = new T3.Mesh(new T3.SphereGeometry(0.95, 28, 16), plastic(0xd9a441, { roughness: 0.7 })); bm.scale.set(1.05, 0.32, 0.85); bm.position.set(-0.2, 0.16, 0); bm.rotation.z = 0.12; beret.add(bm);
    const stalk = new T3.Mesh(new T3.CylinderGeometry(0.025, 0.025, 0.45, 6), plastic(0x6b4a1e)); stalk.position.set(-0.25, 0.5, 0); beret.add(stalk);
    const star = sprite(glowTexture('rgba(255,250,210,1)', 'rgba(255,200,80,.5)'), 0.55); star.position.set(-0.25, 0.78, 0); beret.add(star);
    base(beret);

    // капюшон хакера: арка по форме корпуса + задняя стенка + шнурки
    const hood = new T3.Group(); hood.position.y = -0.35; top.add(hood);
    const hoodMat = plastic(0x2b3144, { roughness: 0.85 });
    const arch = new T3.Mesh(new T3.TorusGeometry(1.4, 0.2, 12, 32, Math.PI * 1.14), hoodMat); arch.rotation.z = -0.07 * Math.PI; arch.scale.set(1, 0.9, 1.2); hood.add(arch);
    const back = new T3.Mesh(new T3.SphereGeometry(1.35, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), hoodMat); back.scale.set(1, 0.8, 0.5); back.position.z = -0.35; hood.add(back);
    [-0.5, 0.5].forEach((x) => { const s = new T3.Mesh(new T3.CylinderGeometry(0.03, 0.03, 0.7, 6), plastic(0xe6e6e6)); s.position.set(x, -0.9, FZ - 0.05); hood.add(s); });
    base(hood);

    const glasses = new T3.Group(); glasses.position.set(0, 0.38, FZ + 0.06); body.add(glasses);
    // круглая оправа, а не сплошные стёкла: глаза должны оставаться видны
    [-0.4, 0.4].forEach((x) => { const g = new T3.Mesh(new T3.TorusGeometry(0.3, 0.05, 10, 32), plastic(0x111318, { roughness: 0.2, metalness: 0.4 })); g.position.x = x; glasses.add(g); });
    const bridge = new T3.Mesh(new T3.BoxGeometry(0.22, 0.05, 0.05), plastic(0x111318)); bridge.position.y = 0.05; glasses.add(bridge);
    base(glasses);

    // ноутбук в руках, экран подсвечивает лицо зелёным
    const laptop = new T3.Group(); laptop.position.set(0, -0.95, BD / 2 + 0.75); body.add(laptop);
    const lb = new T3.Mesh(new T3.BoxGeometry(1.7, 0.08, 1.1), plastic(0x9aa3b2, { metalness: 0.6, roughness: 0.3 })); laptop.add(lb);
    const ls = new T3.Mesh(new T3.BoxGeometry(1.7, 1.05, 0.06), plastic(0x9aa3b2, { metalness: 0.6, roughness: 0.3 })); ls.position.set(0, 0.52, 0.55); ls.rotation.x = -0.25; laptop.add(ls);
    const scr = new T3.Mesh(new T3.PlaneGeometry(1.5, 0.88), glow(0x3dff8a)); scr.position.set(0, 0.52, 0.51); scr.rotation.x = -0.25 + Math.PI; laptop.add(scr);
    const screenLight = new T3.PointLight(0x3dff8a, 0, 6); screenLight.position.set(0, 0.6, 0.2); laptop.add(screenLight);
    base(laptop);

    const doc = new T3.Group(); doc.position.y = 0.18; top.add(doc);
    const cap = new T3.Mesh(new T3.CylinderGeometry(0.75, 0.82, 0.5, 28), plastic(0xffffff, { roughness: 0.6 })); doc.add(cap);
    [[0.42, 0.12], [0.12, 0.42]].forEach(([w, h]) => { const c = new T3.Mesh(new T3.BoxGeometry(w, h, 0.04), glow(0xff3b3b)); c.position.set(0, 0, 0.8); doc.add(c); });
    base(doc);

    // детектив: клетчатая шапка + лупа
    const det = new T3.Group(); det.position.set(0, 0.18, 0); top.add(det);
    const dm = new T3.Mesh(new T3.SphereGeometry(0.9, 28, 16, 0, Math.PI * 2, 0, Math.PI / 2), plastic(0xffffff, { map: plaidTexture(), roughness: 0.9 })); dm.scale.set(1, 0.6, 0.95); det.add(dm);
    const brim = new T3.Mesh(new T3.CylinderGeometry(0.55, 0.55, 0.06, 20, 1, false, -Math.PI / 2, Math.PI), plastic(0x7a4f2e)); brim.position.set(0, 0.02, 0.65); det.add(brim);
    base(det);
    const mag = new T3.Group(); mag.position.set(0.1, 0.15, 0.2); aR.hand.add(mag);
    const ring = new T3.Mesh(new T3.TorusGeometry(0.34, 0.06, 10, 28), plastic(0x6b4a1e)); ring.position.y = 0.55; mag.add(ring);
    const lens = new T3.Mesh(new T3.CircleGeometry(0.32, 28), new T3.MeshStandardMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.45, roughness: 0.05 })); lens.position.y = 0.55; mag.add(lens);
    const mh = new T3.Mesh(new T3.CylinderGeometry(0.05, 0.06, 0.45, 8), plastic(0x3b2a18)); mh.position.y = 0.1; mag.add(mh);
    base(mag);

    // охранник: фуражка с кокардой + фонарик с лучом
    const guard = new T3.Group(); guard.position.y = 0.2; top.add(guard);
    const gc = new T3.Mesh(new T3.CylinderGeometry(0.95, 0.8, 0.45, 28), plastic(0x1b2340, { roughness: 0.6 })); guard.add(gc);
    const visor = new T3.Mesh(new T3.CylinderGeometry(0.6, 0.6, 0.05, 20, 1, false, -Math.PI / 2, Math.PI), plastic(0x0b0f1c, { roughness: 0.2 })); visor.position.set(0, -0.2, 0.62); guard.add(visor);
    const badge = new T3.Mesh(new T3.CircleGeometry(0.16, 6), plastic(0xf2c14e, { metalness: 0.7, roughness: 0.3 })); badge.position.set(0, 0.02, 0.96); guard.add(badge);
    base(guard);
    const flash = new T3.Group(); flash.position.set(0.05, 0, 0.18); flash.rotation.set(-0.15, 0, Math.PI - 0.25); aR.hand.add(flash);
    const ft = new T3.Mesh(new T3.CylinderGeometry(0.09, 0.12, 0.6, 12), plastic(0x2a2d33, { metalness: 0.5 })); ft.position.y = 0.2; flash.add(ft);
    const beam = new T3.Mesh(new T3.ConeGeometry(0.9, 3.2, 24, 1, true), new T3.MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0, depthWrite: false, side: T3.DoubleSide }));
    beam.position.y = 2.1; beam.rotation.x = Math.PI; flash.add(beam);
    base(flash);

    // щит спереди слева
    const shield = new T3.Group(); shield.position.set(-0.75, -0.55, BD / 2 + 0.5); body.add(shield);
    const ss = new T3.Shape(); ss.moveTo(0, 0.6); ss.quadraticCurveTo(0.55, 0.6, 0.55, 0.45); ss.lineTo(0.5, -0.1); ss.quadraticCurveTo(0.35, -0.5, 0, -0.7); ss.quadraticCurveTo(-0.35, -0.5, -0.5, -0.1); ss.lineTo(-0.55, 0.45); ss.quadraticCurveTo(-0.55, 0.6, 0, 0.6);
    shield.add(new T3.Mesh(new T3.ExtrudeGeometry(ss, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.05, bevelSegments: 3 }), plastic(0xcfd6e4, { metalness: 0.7, roughness: 0.25 })));
    const emb = new T3.Mesh(new T3.CircleGeometry(0.2, 5), glow(0x3dd68c)); emb.position.z = 0.16; shield.add(emb);
    base(shield);

    // лампочка над головой — «идея»
    const bulb = new T3.Group(); bulb.position.y = 1.35; top.add(bulb);
    const bulbMat = new T3.MeshStandardMaterial({ color: 0xfff1a8, emissive: 0xffd34d, emissiveIntensity: 0.2, roughness: 0.2 });
    bulb.add(new T3.Mesh(new T3.SphereGeometry(0.36, 24, 16), bulbMat));
    const bbase = new T3.Mesh(new T3.CylinderGeometry(0.16, 0.16, 0.22, 12), plastic(0x9aa3b2, { metalness: 0.7 })); bbase.position.y = -0.38; bulb.add(bbase);
    const bhalo = sprite(glowTexture('rgba(255,240,170,1)', 'rgba(255,200,60,.35)'), 2.2, 0); bulb.add(bhalo);
    base(bulb);

    [-0.42, 0.42].forEach((x) => {
      const leg = new T3.Mesh(new T3.CapsuleGeometry(0.11, 0.22, 4, 12), plastic(0x2a52c4)); leg.position.set(x, LEG - 0.2, 0); squash.add(leg);
      const foot = new T3.Mesh(new T3.SphereGeometry(0.2, 24, 16), plastic(0x1b2a5c)); foot.scale.set(1.15, 0.55, 1.35); foot.position.set(x, 0.1, 0.06); squash.add(foot);
    });
    const shadow = new T3.Mesh(new T3.PlaneGeometry(3.2, 1.2), new T3.MeshBasicMaterial({ map: glowTexture('rgba(0,0,0,0.55)', 'rgba(0,0,0,0.25)'), transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02; root.add(shadow);

    const P = { yaw: 0, spin: 0, x: 0, y: 0, jump: 0, s: 1, rotY: 0.25, rotX: 0.05, rotZ: 0, sq: 0,
      armL: 0.35, armR: 0.35, armLx: 0, armRx: 0, handR: 0, blink: 0, eyeS: 1, happy: 0, look: 0, mouth: 1,
      beret: 1, pencil: 1, hood: 0, glasses: 0, laptop: 0, doc: 0, shield: 0, det: 0, mag: 0, guard: 0, flash: 0, beam: 0, bulb: 0, lit: 0 };
    function apply() {
      root.visible = P.s > 0.01;
      root.position.set(P.x, P.y + P.jump * P.s, 0); root.scale.setScalar(Math.max(0.0001, P.s));
      root.rotation.set(P.rotX, P.rotY + P.spin + P.yaw, P.rotZ);
      shadow.position.y = 0.02 - P.jump; shadow.material.opacity = 1 / (1 + P.jump);
      squash.scale.set(1 + P.sq * 0.5, 1 - P.sq, 1 + P.sq * 0.5);
      aL.sh.rotation.set(P.armLx, 0, -P.armL); aR.sh.rotation.set(P.armRx, 0, P.armR); aR.hand.rotation.z = P.handR;
      eyes.forEach((e) => { e.scale.set(P.eyeS, P.eyeS * (1 - P.blink * 0.92) * (1 - P.happy * 0.6), 1); e.position.x = Math.sign(e.position.x) * 0.4 + P.look * 0.08; e.position.y = 0.38 + P.happy * 0.06; });
      mouth.scale.set(P.mouth, P.mouth * (1 + (P.mouth - 1) * 0.4), 0.5);
      // костюм на голове один: шапки сдвигают берет, а не надеваются поверх
      pop(beret, P.beret); pop(pencil, P.pencil * (1 - Math.max(P.mag, P.flash))); pop(hood, P.hood); pop(glasses, P.glasses); pop(laptop, P.laptop); pop(doc, P.doc);
      pop(shield, P.shield); pop(det, P.det); pop(mag, P.mag); pop(guard, P.guard); pop(bulb, P.bulb); pop(flash, P.flash);
      bulbMat.emissiveIntensity = 0.2 + 2.4 * P.lit; bhalo.material.opacity = P.lit;
      beam.visible = P.beam > 0.01; beam.material.opacity = 0.35 * P.beam;
      screenLight.intensity = 3.5 * P.laptop;
    }
    apply();
    return { root, P, apply, parts: { tip: lead, shield, head: beret, bulb, eye: eyes[0] } };
  }

  function makeStage(canvas, opt = {}) {
    const renderer = new T3.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1); renderer.setSize(W, H, false);
    renderer.outputColorSpace = T3.SRGBColorSpace; renderer.toneMapping = T3.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    const scene = new T3.Scene();
    // «flat» — узкий угол обзора: персонаж почти без перспективных искажений, как в 2D-кадре
    const dist = opt.dist || 15, fov = opt.flat ? 28 : 40;
    const cam = new T3.PerspectiveCamera(fov, W / H, 0.1, 200); cam.position.set(0, 0, dist); cam.lookAt(0, 0, 0);
    scene.add(new T3.HemisphereLight(0xffffff, 0x8090b0, 1.4));
    const key = new T3.DirectionalLight(0xffffff, 2.2); key.position.set(-4, 6, 8); scene.add(key);
    const rim = new T3.DirectionalLight(0xbcd4ff, 1.2); rim.position.set(5, 3, -6); scene.add(rim);
    const ppu = H / (2 * dist * Math.tan(T3.MathUtils.degToRad(fov / 2)));
    const chars = [];
    const at = (px, py) => ({ x: (px - W / 2) / ppu, y: (H / 2 - py) / ppu });
    const v = new T3.Vector3();
    return {
      ppu, scene, camera: cam,
      at,
      add() { const c = buildCharacter(); scene.add(c.root); chars.push(c); return c.P; },
      render() { chars.forEach((c) => c.apply()); renderer.render(scene, cam); },
      pointOf(P, pose, part) {
        const c = chars.find((k) => k.P === P); if (!c) return { x: 0, y: 0 };
        const keep = Object.assign({}, P); Object.assign(P, pose); c.apply(); c.root.updateMatrixWorld(true);
        c.parts[part].getWorldPosition(v); v.project(cam);
        Object.assign(P, keep); c.apply();
        return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H };
      },
    };
  }
  window.makeStage = makeStage;
})();
